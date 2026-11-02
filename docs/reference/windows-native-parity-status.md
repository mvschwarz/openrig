# Native Windows parity: implementation and evidence

## Literal session names in probe rollback format conditions (2026-11-03)

Probe rollback previously inserted the session name directly into a nested
tmux format comparison. Real tmux reproduced a same-session comparison failing
for closing braces, format-looking `#{session_id}`, consecutive hashes and
hash-delimiter combinations. Probe creation now escapes ordinary session-name
hashes, and rollback uses a literal format operand that also escapes comma and
closing-brace delimiters. Hash runs before style brackets retain tmux's existing
semantics. Mapped native names continue through marker registration; this change
does not expand the native filename codec or adopt existing unmarked sessions.
Format delimiters follow the upstream [tmux manual](https://man.openbsd.org/tmux#FORMATS).

Five complete related files passed 73/73 on Windows; additional native/legacy
regression files passed eight with nine opt-in/platform skips, overlapping the
first set. Daemon TypeScript/assets build passed. The actual compiled helper
was then used against real WSL tmux for eight comma/brace/hash/style name cases:
each session retained its expected literal name, each same-name comparison
returned true, and each different-name comparison returned false. The fixture's
owned sockets, sessions and files were cleaned. A first experimental escape
that doubled every hash failed the style-bracket case and was not adopted.

The real check qualifies format evaluation, not a concurrent hostile server
replacement or actual stock psmux rollback. Installed and full-directory receipts
above predate this repair. No deployment, original-team operation or public push
occurred.

## Installed watcher reads a real owned SSE stream (2026-11-03)

The complete native build/pack/isolated-prefix install gate passed at
`a0d6490d019f8f63d0087de742ea05cc7046a60d` in 70 seconds on the second ordinary
invocation, with unchanged HEAD and tracked diff. The first invocation exited
0xC0000005 during daemon compilation, before the SSE probe; it remains a failed
build receipt rather than an SSE result. No Node/worker variant was introduced.

The gate runs the actual installed `chatroom-watch-child.js` and CLI against an
owned HTTP listener on an ephemeral loopback port. It supplies incorrect old
home/URL environment values, then passes the intended home/URL and a literal
Unicode/pipe/quote-bearing rig as child arguments. The actual CLI performs health,
rig-summary and chat-watch GETs against the intended listener, renders its SSE
message and exits zero when the stream closes. All observed requests are GETs.
The listener and temporary home are closed/removed afterward. This verifies the
installed entry/import/connection/rendering path with real HTTP/SSE, while the
service responses are fixture data. The installed mapped-command and offline
cleanup probes and the remaining gate checks also passed at this head.

This is not a real provider or psmux-in-pane watcher qualification, a desktop
attachment, live user-daemon acceptance or all-host transport proof. Existing
full-directory failures and deferred real-provider/remote dependencies remain.
No deployment, team/provider startup or public push occurred.

## Real POSIX command creation and offline stop at 4335017 (2026-11-03)

Ordinary-user WSL compiled the paired daemon at
`4335017d2274511f2ba42864ddfc53b804469c63` after matching 4,730 public tracked
regular files. Public hashes and the existing private dependency's normalized
Git identity matched before/after compilation; private source was not viewed
or copied. Six documentation links and other mirror files remain outside
complete checkout equivalence.

The real tmux fixture created the same pipe/Unicode/hash-bearing logical name
on two independently owned socket paths, using the new production command
creation surface and literal Node child arguments. Both children independently
wrote the expected arguments. Stopping the first session through the new
offline cleanup surface left the second server's session present; querying the
first afterward returned missing, and stopping the second final session returned
stopped. Both owned sockets/processes and temporary files were cleaned. This
qualifies this POSIX creation/isolation/final-session-stop case, not the actual
watcher SSE path, Windows stock psmux, desktop attachment or provider continuity.
No deployment, original-team operation or public push occurred.

## Installed command/cleanup gate and final-session classification (2026-11-03)

The native build/pack/isolated-prefix install gate passed at
`25d23ff8127332ae7015e2df54e8d0e95c9fc661` in 71 seconds, with unchanged HEAD
and tracked diff. Its installed probe confirms the watcher child entry ships,
imports the shipped terminal-control surface, creates a mapped session through
a controlled backend using a pinned executable/prefix, checks literal child
arguments and then observes stopped and missing cleanup results. Existing
installed argv, binary SFTP transport, timestamps, exact helper assets, SQLite
ABI, resources and rig.cmd loading checks also passed. This controlled backend
does not establish real psmux or desktop operation. Leak-guard term checks had
no rules file and are not qualified by this gate.

A subsequent cleanup correction recognizes the adapter's positive
`no server running on ...` diagnostic as missing before stop or stopped after
successful termination. Last-session POSIX cleanup must not become unknown
merely because tmux exits when its final session ends. Permission/other transport
errors remain unknown and do not authorize cleanup. Related complete cleanup,
command and destroy files and daemon build passed. The installed gate above
predates this classification correction. No deployment or public push occurred.

## Chatroom watcher follows the selected terminal instance (2026-11-03)

`chatroom watch --tmux` now confirms the selected instance locally and reads its
structured executable/prefix and server metadata before creating a terminal.
Remote addresses, forwarded foreign instances and missing/malformed server
metadata refuse creation. The daemon terminal adapter creates the detached
literal command, requires a session-ID/creation-time receipt and registers
mapped native logical names through the existing marker checks. Occupied mapped
names are not overwritten; unconfirmed creation is retained without retry.
Native attach guidance carries the selected executable/server and uses the
verified single-attach wrapper for mapped names. POSIX guidance uses the returned
immutable session ID to tolerate tmux's name normalization.

A paired Node child entry sets the selected home and URL before importing the
CLI. This prevents a surviving multiplexer server's old instance environment
from redirecting the watcher. Its owned process fixture executes the actual
entry source with a recorder replacing only the CLI, checks literal Unicode,
quotes and metacharacters, and verifies legacy home/URL overrides are removed.

Eight complete CLI/adapter/cleanup files passed 94 tests with 17 platform skips
on Windows. Four complete focused files then passed 19/19, overlapping the
first set. They cover command-entry propagation, foreign-instance refusal,
native marker registration, occupied names, literal argv, ordinary tmux/psmux
format escaping and unconfirmed receipts. Daemon build, CLI noEmit and whitespace
checks passed. Existing real tmux/psmux argument fixtures exercise the older
exported argument helper, not this new production creation/child-entry path;
their old receipts do not qualify this path. Current stock psmux, POSIX real
watcher, installed-package and full-directory verification remain to be refreshed.
No actual user watcher, provider, team, deployment or public push was started.

## Offline destroy retains uncertain session recovery state (2026-11-03)

Offline destroy now reuses the daemon's terminal adapter instead of issuing a
raw PATH tmux kill against a logical name. Native mapped names therefore pass
through marker verification and guarded native stop. Cleanup distinguishes an
observed absent session from an unknown transport/identity result and requires
observed disappearance after a successful stop. The selected recorded server
arguments are retained. This does not yet persist a daemon-resolved executable
for offline use; normal adapter executable discovery still applies.

An unknown result stops further session cleanup and leaves state targets intact,
with a recovery warning and nonzero CLI exit. Previously every failed stop was
counted as missing and state processing continued. Explicit missing results may
continue; legacy injected false results are conservatively unknown.

Five complete cleanup/destroy/mapping/exact-target files passed 86/86 on Windows,
including command exit behavior, no delete/rename/recreate after uncertainty,
positive absence and stop readback. Daemon TypeScript/assets build passed on
the second ordinary invocation; the first compiler process exited 0xC0000005
without a source diagnostic. CLI noEmit and whitespace checks passed after the
final exit-condition adjustment. These are controlled fixtures, not actual instance destruction or
the still-unresolved real mapped psmux EBUSY cleanup. Installed-package and
paired full-directory receipts above predate this repair. No deployment,
actual destroy, team restart or public push occurred.

## Paired full CLI/TUI/UI checkpoint at 0cfa4a8 (2026-11-03)

Both platforms selected 758 test files at
`0cfa4a8a351aaa0c9f550adf18b02eee8da95c41`. Windows completed in 11 minutes
28 seconds: 9,632 tests, 9,512 passed, two failed and 118 pending. Ordinary-user
WSL completed in 5 minutes 21 seconds: 9,631 tests, 9,401 passed, none failed
and 230 pending. These durations are not a performance comparison: the Windows
Node is 24.14.1 and WSL Node is 24.11.0, and platform skips differ.

The native Windows Terminal discovery fixture with an owned PATH lacking system
tools still failed. The other failure was the Usage across hosts disabled-view
journey: its rendered screen did not contain the daemon's expected disabled
message. The complete 12-test journey file passed when run alone afterward.
The full-run failure remains unresolved; the passing follow-up neither explains
the cause nor makes the full run green. No assertion or timeout was relaxed.

All 4,723 public tracked regular files matched the snapshot before/after the
paired work; native HEAD and tracked diff were also stable. WSL compiled the
paired daemon and matched its existing private dependency's normalized Git blob
before/after compilation and after the suite, without viewing or copying that
source. Six documentation links and mirror untracked/generated files remain
outside complete checkout equivalence. The private untracked diagnostic was
excluded. Separate eight-file terminal checks passed 93 with three skips on
Windows and 96 on WSL, covering mappings, guarded stop/rollback, exact targets,
environment reads and client routing. Skips are not completed acceptance.

This is not a full daemon-suite, real-provider, stock-psmux, deployed runtime or
desktop acceptance receipt. No public push, deployment or team restart occurred.

## Direct attachment retains daemon executable metadata (2026-11-03)

Terminal status and bound-node inventory now report the daemon's attach
executable and prefix arguments as structured data. Direct terminal attach and
shared TUI preserve these arguments for ordinary names and the verified native
mapped-name wrapper. They no longer discard an available daemon executable in
favor of the caller's PATH lookup. Missing metadata retains compatibility with
older daemons; malformed metadata refuses attachment without spawning. Existing
host and isolated-instance locality checks still run before local attachment.

Five complete CLI/inventory/server test files passed 124/124; the complete
terminal-service and local-attachment files then passed 104/104, including
status-to-command propagation. These sets overlap and are not a unique-test
total. Daemon TypeScript/assets build, CLI noEmit and whitespace checks passed.
The first entry-test run failed to transform because the added fixture reused
a local variable name; the corrected complete files passed. Tests use controlled
launches and provider responses, not a deployed daemon or real desktop attach.
Production executable discovery remains best effort; no deployment, public
push or full current Windows/WSL equivalence is claimed here.

## Mapped native session stop and probe rollback (2026-11-03)

Native probe rollback now selects the verified physical psmux server and uses
kill SELF only when the original session name, ID and creation time still
match. The previous rollback used an explicit `$N` kill target, which the
native stop implementation already avoids. POSIX keeps its existing target
semantics. A changed identity is retained; losing the logical binding prevents
the kill conditional from being sent.

The complete mapped-stop, mapped-adapter and exact-target test files passed
60/60 on Windows, and the daemon TypeScript/assets build passed. Five new
controlled cases cover successful stop with observed absence, identity change,
marker loss and both probe rollback outcomes. These controlled transports do
not qualify actual stock psmux cleanup or desktop attachment. The earlier real
mapped-name fixture cleanup EBUSY failures remain unresolved; it was not rerun.
No deployment, team restart or public push occurred.

## Scope moves compare mission directory identity (2026-11-03)

Slice move/ship previously identified a same-mission destination by folder
name alone. Owned native junction and case aliases reproduced that check being
bypassed and composition handling reporting a changed-manifest conflict rather
than refusing the same destination. Both commands now resolve the existing
source mission and compare directory device/inode identities before allocating
the target ordinal or planning membership edits. Unavailable directory identity
refuses the operation; names are not blanket-lowercased, and the source mission
is not guessed from a fixed slice-path depth.

Four native regressions failed before the repair. They now refuse junction and
case aliases for move and ship while preserving the mission tree's names,
contents, inode observations and modification times. POSIX symlink aliases are
also covered on WSL. Two complete related files passed 140/140 on Windows and
137 with three native-only skips on ordinary-user WSL after the two changed
source/test files were copied and byte-compared. CLI TypeScript noEmit and
whitespace checks passed. Existing cross-mission moves and rollback scenarios
remain covered in that complete command file.

These use owned temporary mission/Git fixtures, not current user missions or
running teams. They do not establish atomicity against concurrent filesystem
replacement or qualify case-sensitive NTFS hosts. Full-directory and installed
receipts below predate this repair; no public push or deployment occurred.

## Installed spec entry location identity (2026-11-03)

The specs add receipt previously selected the first synchronized entry with
the same name and path suffix. Owned fixtures reproduced a foreign library
entry being reported as the newly installed spec, including when the foreign
location was a hardlink. A separate native fixture reproduced a legitimate
filesystem case alias producing no entry ID. Matching now requires the actual
installed root YAML's canonical filesystem path, name and kind; only a unique
match supplies the ID/entry. Foreign-only or duplicate matches remain null
rather than choosing an arbitrary registration. Distinct hardlink locations
remain distinct registrations; no blanket lowercasing merges native paths.

Six new file/directory installation cases failed before the repair and passed
afterward on Windows. Three complete spec CLI files passed 30/30 there, and
29 with one native case-alias skip on ordinary-user WSL after the two changed
files were copied and byte-compared. CLI TypeScript noEmit and whitespace
checks passed. Fixtures perform real owned file/directory copies and hardlink
operations with controlled review/sync responses; they do not qualify concurrent
library replacement, a deployed daemon or case-sensitive NTFS acceptance.
Earlier whole-directory and installed receipts predate this repair. No existing
user spec, original team, running instance or public branch was changed.

## Workflow drive-relative source selection (2026-11-03)

The instantiate/run source selector previously recognized absolute paths,
separator-bearing paths and existing bare files. A missing Windows drive-
relative operand such as D:flow.yaml therefore fell through to discovered-name
lookup instead of being resolved in the caller's drive context. Both commands
now treat a native drive prefix as a path independently of file existence.
POSIX retains the existing meaning of the same colon-bearing string; ordinary
discovered names, existing extensionless files and same-name directories keep
their previous selection rules.

Two native command regressions failed before the repair. The complete workflow
CLI file passed 24/24 on Windows and 24/24 on ordinary-user WSL after the two
changed source/test files were copied and byte-compared. CLI TypeScript noEmit
and whitespace checks passed. The fixtures inspect actual CLI request bodies
with controlled daemon responses and unique missing filenames; they do not
launch a workflow/provider, write the missing source or contact an original
instance. Earlier full-directory and installed receipts predate this repair;
the remaining parity requirements and aggregate push remain pending.

## Context install and serving share portable path validation (2026-11-03)

A bounded reconciliation of five older path-inventory candidates found a
remaining contract mismatch: daemon context parsing/serving already rejected
drive-relative references and NUL, while the CLI install validator accepted
them. The CLI now consumes the same existing validateSafePath implementation
through the paired context surface, rather than maintaining another native
absolute/traversal predicate. Portable manifest acceptance therefore agrees
across Windows and Linux, including C:notes.md, drive-absolute paths, separator
variants and NUL; valid literal dots and supported text assets remain accepted.

Two native regressions failed before the repair. Three complete context files
then passed 37 cases on Windows with one POSIX permission skip, and 38/38 on
ordinary-user WSL after the four changed source/test files were copied and
byte-compared and its paired daemon rebuilt. Actual context add command tests
confirm refusal before creating the local store or posting synchronization,
while the source manifest remains unchanged. Native daemon build, CLI TypeScript
noEmit and whitespace checks passed. Tests use owned files and controlled
daemon responses, not a running original instance.

The local context-path-batch-20261103.json binds the five selected review rows
to source hashes. Four remain source-review-only; being outside the old 222-row
public ledger is not proof they were never reviewed later. This is not an
exhaustive file/path audit or a complete package/install receipt. Earlier whole-
directory and installed evidence predates this shared-export repair; no public
push, deployment or original-team change occurred.

## SFTP text identity without lossy replacement (2026-11-03)

SFTP text fields previously used replacement UTF-8 decoding. Controlled wire
peers reproduced malformed, overlong, surrogate and truncated sequences being
accepted as replacement-character names. A real isolated Linux SFTP directory
containing both an invalid-byte filename and a distinct valid replacement-
character filename then reproduced a successful copy that omitted the former.
This was an integrity defect, not a complete-directory transfer.

Text decoding now rejects invalid UTF-8 before path use. Outbound text also
rejects unpaired UTF-16 surrogates rather than silently changing their wire
identity. Valid Unicode, emoji, literal replacement characters and leading BOMs
are preserved exactly; file contents remain arbitrary binary buffers. Refusal
does not manufacture a filename mapping: full preservation of arbitrary POSIX
byte names on Windows remains unimplemented, and this repair does not close
that representability requirement.

The controlled invalid-text cases and real Linux alias case failed before the
repair. Seven complete related files then passed 57 cases on Windows with
15 skips, and 39 on WSL with 33 native-only skips. WSL used the pre-existing
isolated SFTP executable after the changed source/test files were copied and
byte-compared. The real alias case now reports failure and leaves the existing
destination entries unchanged. CLI TypeScript noEmit and whitespace checking
passed. These checks use owned local peers/subsystems, not the remote SSH host
or provider authentication. Whole-directory and installed receipts below
predate this repair; no main runtime/team or public branch changed.

## Stable launch environment and native lease identity (2026-11-03)

Session creation previously checked only the exact OPENRIG_NODE_ID property,
while a native Windows child resolves environment names case-insensitively.
Its caller-owned environment object also remained mutable across asynchronous
preparation: a controlled regression changed the observed identity and a
synthetic value after the lease check. Creation now takes a shallow snapshot
of the string-valued environment before checking the lease. Native psmux uses
the existing Windows lookup rule, including duplicate-key precedence; POSIX
terminal launches retain exact-name matching. Creation and fresh-pane custody
both use the same captured identity, not a later read of the caller's object.
An identity whose lifecycle lease is not held still refuses before dispatch.

Three regressions failed before the change: two legitimate native key spellings
were refused, and asynchronous preparation observed changed values. The final
five new boundary tests and complete delivery-guard file passed 39/39 on
Windows; the same two files passed 36 with three native-only skips on WSL after
the changed source/test files were byte-compared. The complete native private
bootstrap file passed six with one existing opt-in skip, including real shell
receiver and consumed-bootstrap recovery checks. Daemon TypeScript build and
whitespace checks passed.

The new identity regressions use real lifecycle leases and SQLite state with
the terminal creation boundary controlled; they do not launch an actual managed
provider or prove its later conversation continuity. Existing Stop/hold behavior
is unchanged. Earlier whole-directory and installed receipts predate this
repair, and no running instance, original team or public branch was changed.

## SFTP native transport descendant custody (2026-11-03)

The default native SFTP transport previously used ordinary spawn for ssh. A
real owned receiver reproduced its detached descendant surviving successful
parent exit. Windows now starts the transport in the existing atomically
assigned kill-on-close Job, retaining binary pipes and shell-free native argv.
SFTP handshake failure/request deadlines and normal transport close therefore
retain custody of local SSH/ProxyCommand descendants. POSIX retains ordinary
spawn. Synchronous native command-lookup ENOENT is now also classified as
ssh-missing; it is not confused with a remote command or a local file error.

Seven new checks cover real upload/download through the same transport helper
with a local SFTP subsystem, parent success/exit 7/handshake timeout descendant
exit, literal binary stdin/stdout/argv, and missing native command classification.
Six complete related files passed 47 cases on Windows with 14 skips. After the
three changed source/test files were copied and byte-compared and the paired
daemon rebuilt, WSL passed 28 with 33 native-only skips using its pre-existing
isolated SFTP executable. Native daemon build, CLI TypeScript noEmit and
whitespace checks passed. The initial failing custody fixture explicitly
stopped its surviving owned descendant during cleanup.

The installed control probe now also imports the installed SFTP module and
passes binary bytes through its transport helper, checking the paired spawn
export. Its updated package gate is pending at this revision. These are local
subsystem and process-custody proofs, not SSH authentication, an actual
ProxyCommand configuration, remote continuity or full directory revalidation.
No existing SSH connection, original team or running deployment was changed.

The updated installed gate subsequently passed at clean source
c97467c6f8d7eb1a453c4819a497d88a8f9440a7 in 68 seconds. The installed SFTP
module loaded the paired spawn export and preserved binary bytes through its
native Job-backed transport helper. The terminal control probe, source build,
tarball/isolated-prefix install, SQLite, installed resources and rig.cmd checks
also passed; before/after HEAD and tracked-diff hashes matched. Receipt:
pack-terminal-assets-c97467c.json and its complete log. This closes only the
pending installed-export check above, not real remote SSH/provider acceptance
or newer complete-directory verification.

## SFTP source byte-count verification (2026-11-03)

This repair is newer than the frozen whole-workspace checkpoint below. A real
owned Windows SFTP subsystem reproduced a short source stream being published
successfully despite its earlier LSTAT advertising more bytes. Both upload and
download now count the source stream and reject an excess or premature EOF
before applying final metadata or renaming the stage over the destination.
The original target stays intact and the failure retains the staging hint.
A local source mismatch is classified as local-copy-failed, rather than sending
the operator to investigate the remote command. The diagnostic reports the
observed byte-count mismatch without asserting its external cause. If a server
omits optional source size, a successful transfer reports actual streamed bytes.

Five new cases use real owned SFTP subsystem processes: each direction grows or
shrinks its actual source between observation and reading; another transfers
binary bytes while the interface omits optional size. The first short-download
case failed before the repair and all five passed afterward on Windows and
ordinary-user WSL. These establish byte-count agreement, not an immutable source
snapshot or detection of same-size content edits.

Five complete related files passed 40 cases on Windows with 14 skips. WSL's
initial default server selection skipped all 54 and was not accepted as proof;
using the previously prepared isolated Linux SFTP executable then passed 25
with 29 Windows-only skips. Final error-attribution checks reran all five new
native cases and the full WSL selection successfully. The two changed files
were byte-compared on WSL; CLI TypeScript noEmit passed. No SSH authentication,
remote test host, original team or running deployment was used. Full-directory
and installed receipts below predate this repair and do not cover it.

## Current verification checkpoint (2026-11-03)

Full parity remains incomplete. Later entries below are scoped evidence; older
tables are historical and must not override this checkpoint or later receipts.
The following complete CLI/TUI/UI selections used frozen source
f7946ecbec567075cca17e5106f0b3d40f6318ea, after the recent Podman, viewer,
native Rex entry and terminal-control custody repairs.

| Platform | CLI passed / failed / skipped | TUI passed / failed / skipped | UI passed / failed / skipped |
| --- | --- | --- | --- |
| Native Windows | 6,377 / 1 / 97 | 1,232 / 0 / 19 | 1,837 / 0 / 0 |
| Ordinary-user WSL | 6,291 / 0 / 183 | 1,237 / 0 / 14 | 1,837 / 0 / 0 |

Windows totals: 9,446 passed, one failed, 116 skipped in 11 minutes 14 seconds.
WSL totals: 9,365 passed, zero failed, 197 skipped in 5 minutes 21 seconds.
The sole Windows failure remains terminal-window-windows.test.ts's owned-PATH
system-discovery case. This complete-directory run retained it; no new variant
of its exhausted bounded investigation was attempted. Skips are unverified
coverage, not passes. UI uses jsdom rather than visible desktop acceptance.

All 4,705 public regular files matched the snapshot before/after WSL tests;
Windows HEAD and tracked-diff hashes also stayed unchanged. Six symlinks remain
outside that comparison. The excluded dependency's Git-normalized identity
matched before/after the paired WSL daemon compilation and after the suites,
without viewing or copying its source. WSL compilation initially started before
the public overlay completed and refused a missing new file; after the original
overlay finished, compilation passed. That ordering mistake did not enter the
WSL suite and is not a product failure. Native Node was 24.14.1 and WSL Node
24.11.0; these are same-source functional results, not a performance benchmark.

| Goal requirement | Implemented and scoped evidence | Still incomplete or unqualified |
| --- | --- | --- |
| Independent terminal servers | Durable namespace selection, migration guards, exact attachment routing and environment spelling; owned stock psmux sibling isolation and mixed-case routing passed. | Concurrent server-name/PID exchange atomicity and literal-pipe session names. |
| OpenShell / Podman engine path | Native rootless Podman pipe discovery, negotiated Libpod API and real container/observer capture, removal and absence checks passed. | Actual OpenShell CLI lifecycle; native build/distribution and Linux-guest contract qualification. |
| File transfer and metadata | Native CLI local/SFTP paths, binary transfer, scoped symlink/readonly/timestamp and replacement recovery checks exist. | POSIX owner/group/execute, directory ACL and special-file equivalence; remaining remote/case-sensitive-host qualification. |
| Terminal backend mapping | Native Herdr viewer/follow contracts, staged long cmd argv, explicit Rex CLI route and bounded Job control are implemented and scoped-tested. | Real Herdr foreground/GUI and Rex app/server acceptance; other shell/backend combinations. |
| Stock psmux environment privacy | Private bootstrap/recovery, selected environment forwarding and consumed-bootstrap respawn have scoped real stock receipts below. | Full real-provider/installed-runtime continuity and the remaining host/terminal matrix. |
| Whole-version acceptance | Complete current CLI/TUI/UI comparison and the clean d23b093 installed gate passed their stated scopes, except the one Windows discovery failure. | Full daemon suite remains crash-blocked; deferred OAuth, unreachable owned SSH host, other host/user/runtime lifecycle checks and deployment remain open. |

Receipts: workspaces-comparison-f7946ec.json,
workspace-cli-tui-f7946ec-metadata.json,
cli-tui-ui-wsl-f7946ec-verified-metadata.json,
daemon-build-wsl-verified-f7946ec.json,
private-version-post-suite-f7946ec.json and their full reports/logs.
No main runtime/team restart, publication or push was performed. The goal is
not complete; the remaining rows are not waived by these passing checks.

## Legacy Pi/OMP restore selection forwarding (2026-11-02)

The legacy Pi resume API now accepts a trailing selection guard, shared by OMP. It checks before preparation and after asynchronous staging, passes the guard to the write boundary, and rechecks before the no-input path-length fallback. Refusal remains attention-required; missing conversation files retain their existing retry-fresh/stop-and-ask handling. RestoreOrchestrator now forwards its selected-history guard to both legacy adapters and refuses a known-invalid selection before calling them, preserving old argument layouts when no guard exists.

Six adapter cancellation cases cover Pi initial/staging/write/fallback and OMP initial/write behavior. Four database-backed orchestrator cases verify no resume call for an invalid selection and exact callback forwarding for a valid selection. The complete Pi adapter file passed 75 tests and the new orchestrator file four on Windows; the same two complete files passed 79/79 on ordinary-user WSL; daemon typecheck passed. Sidecars, readiness and native dispatch are controlled in these tests. Real provider continuity, late-cancellation metadata preservation and full current-head restore acceptance are not established by this result.

## Contained launch selection and uncertain native custody (2026-11-02)

Contained startup now refuses an initially invalid selection before issuing grants or writing a launch intent. After the native preparation request, it rechecks selection before viewer dispatch and passes the same guard to the viewer's transport write boundary. A late refusal reports viewer-unconfirmed and retains the original requested operation; it does not claim that native execution never started or try to undo/relaunch an uncertain effect.

Three regressions reproduced the initial-grant and late-viewer omissions. They now verify zero viewer effects, retained requested state after a late cancellation, and a later same-ID identity reconciliation to confirmed with exactly one grant and one prepare request and no viewer replay. The complete environment-startup file passed 20/20 on Windows and 20/20 on ordinary-user WSL; daemon typecheck passed. The OpenShell CLI/guest boundary is supplied by a synthetic driver, so real OpenShell/Podman native lifecycle and all-engine parity remain unqualified.

## Community harness selection and dispatch receipts (2026-11-02)

Ordinary and named-conversation community launches now check the existing selection callback before preparation and at their transport write boundary. Selection is checked before marking first input/model typing, so a refused launch does not report either as passed or confirmed. Twelve initial/staging/before-write regressions, with and without first-input/model metadata, reproduced the ignored callback and now pass. Unexpected errors and genuinely uncertain post-typing outcomes retain their existing handling.

The complete community-harness file passed 72 with one opt-in native case skipped on Windows, and 72 with one Windows-only filename case skipped on ordinary-user WSL; daemon typecheck passed. An old shell-readiness assertion now expects the existing native-lineage-unverified result on Windows while still requiring not-ready. Skips remain unqualified. This covers controlled dispatch/receipt behavior, not real community providers, contained native execution or a complete runtime suite; contained post-prepare viewer dispatch remains a separate audit item.

## Pi/OMP selected-history dispatch and fallback (2026-11-02)

The shared Pi/OMP runner adapter now accepts the existing beforeNativeDispatch contract. It refuses an already changed selection before launch preparation, rechecks after Pi environment staging, passes the guard to the transport write boundary, and rechecks before a no-input path-length fallback. Previously the option was ignored by this implementation. Eighteen controlled fresh/fork/resume cases reproduced the omission and now require no typed command or Enter on refusal, including a selection change after the wrapped launch was refused as too long.

The complete Pi runtime-adapter file passed 69/69 on Windows and 69/69 on ordinary-user WSL, with no skips. Four additional actual native PowerShell dispatch cases passed for Pi/OMP fresh/resume and Pi routing/fallback behavior; daemon typecheck passed. The cancellation cases use in-memory sidecars and controlled readiness, and the native cases use synthetic receivers. They do not qualify real Pi/OMP provider continuity, unchanged preparation metadata after late cancellation, or a full current-head runtime suite. Community/contained harness selection paths remain a separate follow-up.

## Codex fork selected-history dispatch parity (2026-11-02)

The corresponding Codex audit found its fork branch omitted both selected-history checks used by fresh/resume: one after asynchronous command staging and one at the transport write boundary. Six deferred-staging/write regressions reproduced both fork failures while the four fresh/resume controls passed. Fork now uses the same pre-dispatch refusal and before-write callback. No text or keys are emitted when selection changed.

The complete Codex runtime-adapter file passed 152/152 on native Windows and 152/152 on ordinary-user WSL, with no skips; daemon typecheck passed. Existing positive fork argument/readiness cases remain active. Preparation, pane/process observations and provider readiness are controlled in the new cancellation fixtures, so this is dispatch-boundary acceptance rather than real Codex provider continuity or full runtime deployment.

## Selected-history changes during restore-home lookup (2026-11-02)

Eight deferred-lookup regressions now cover fresh, fork, resume and legacy-resume in classic and explicit managed-permission modes. When history selection changes before the lookup returns, no launch text or Enter is emitted. The transport fixture invokes the actual before-write callback contract rather than pretending a recorded command is a completed effect.

This found a managed-fork discrepancy on both platforms: that branch supplied only the prepared-launch assertion and omitted the combined selected-history guard used by the other managed entry points. It now passes the same combined guard. The complete managed-read file passed 28/28 on Windows; five complete related files passed 133/133 on ordinary-user WSL; daemon typecheck passed. Existing positive fresh/fork/resume cases also remain active. These are controlled selection/dispatch tests, not actual provider launches or stock-pane qualification of managed forks.

## Restore-home observation and occupant/Stop races (2026-11-02)

The asynchronous session-home lookup is now covered by explicit cancellation, generation-change and policy-disable races. The new generation-change regression initially reproduced an old restore prompt being sent after its captured occupant changed during the lookup. The current-stage check now revalidates both the known generation and the policy/operator exemption after asynchronous waits and at the existing before-write boundary, while retaining the existing unknown-generation semantics and operator-initiated manual exemption.

All three races require no further send after the deferred observation returns. Five complete shared restore/enforcer/hook files passed 125/125 on Windows and 125/125 on ordinary-user WSL, with no skips; daemon typecheck passed. No real team was stopped, handed over or resumed by these fixtures. This validates these controlled race boundaries, not all transport races or a complete daemon/provider acceptance run.

## Restore tilde paths when daemon and pane user homes differ (2026-11-02)

A real stock-pane regression reproduced the remaining mismatch: the receiver inherited its configured pane user home, while the daemon granted the same `~` extra beneath its own different user home. Fresh/fork/current-resume and legacy-resume launch grants now observe the selected session's USERPROFILE on Windows or HOME on POSIX when a tilde extra is configured. Post-compaction extra selection and prompt generation use that same observation. Provider account/config directories remain separate, and no pane HOME is overwritten.

SessionTransport resolves the logical seat address through the existing current-physical-session registry before reading this environment value. Actual database tests cover direct and renamed logical addresses. Missing, failed, relative or control-bearing home observations are not adopted; legacy transports retain their ordinary daemon-home default. That fallback is compatibility behavior, not evidence that an unavailable/different pane home works. Manual shell-local home changes that are not reflected in session environment remain unqualified.

Five complete shared restore/enforcer/hook files passed 122/122 on Windows and 122/122 on ordinary-user WSL, with no skips. The native seven-case launch file also passed with stock psmux enabled, including different daemon/pane homes, a third provider account directory, exact user-home grants and negative checks against both other homes. Daemon typecheck passed. This remains scoped acceptance; actual provider continuity, cross-user execution, complete same-head daemon validation and the running deployment are not qualified.

## Provider account directory versus user-home restore paths (2026-11-02)

The actual stock-pane fixture now separates three owned locations: the daemon instance home, the pane user's HOME/USERPROFILE, and the selected provider account directory. SeatLaunchEnvironment receives an explicit synthetic account selector. Its Node receiver proves that CLAUDE_CONFIG_DIR selects that account while HOME/USERPROFILE retain the pane's user home. The `~\extra [owned].md` read rule names the user-home file and does not grant same-named files beneath the instance or provider account directories.

The complete native restore-launch file passed 7/7 with stock psmux enabled and verified owned-session disappearance. The initial fixture changed only daemon-side environment, leaving the already created pane on its original home; its failure is superseded by setting the intended user home at actual pane creation. No production HOME override was added. This is synthetic account-directory selection and parameter transport, not account authentication, different Windows users or a deliberately different daemon-versus-pane user-home configuration.

## Restore settings through native PowerShell and a stock pane (2026-11-02)

Six existing native pinned-launch scenarios now distribute the three Windows home-prefix forms across fresh, fork, resume, legacy-resume and JS-script launches. Actual PowerShell execution into synthetic Node receivers preserves one parseable settings JSON, exact custom-file grants (including bracket escaping), member deny/allow rules and conversation arguments. The daemon and receiver user-home fixtures are deliberately aligned; differing account-home semantics are not qualified by these cases.

A new opt-in case runs the actual Claude adapter, SeatLaunchEnvironment and TmuxAdapter through an independently owned stock psmux 3.4.0 pane. Its synthetic Node receiver records the settings JSON and launched session ID; the configured OPENRIG_HOME prefix resolves to the exact intended rule. The test verifies successful owned-session stop and subsequent absence, then removes its owned server/directory resources. The complete native file passed 7/7 with stock psmux enabled.

This qualifies the fresh-launch transport through a real pane and the six direct PowerShell command scenarios. It does not qualify real Claude execution/authentication, all fork/resume modes through stock psmux, visible desktop rendering, mismatched account homes, Linux execution of this Windows-only file or the running main instance.

## Native managed-restore read regression harness (2026-11-02)

The previously failing managed-read fixture now runs the generated POSIX command text through a Git Bash script file on Windows and `/bin/sh` on POSIX. A private shell function records argv, so no provider is executed. The file avoids Windows `-c` argument reparsing of nested quotes/backslashes, which had corrupted the synthetic hook-command JSON. Expected permission paths use the protocol's forward separators, native canonical fixture roots and drive-aware prompt extraction; existing exact-grant, deny/ask preservation, symlink spelling and canonical-seat assertions remain active.

The complete managed-read file now passes 19/19 on Windows. Together with instruction-prefix, enforcer and PreCompact hook files, both Windows and ordinary-user WSL pass 111/111 with no skips. This supersedes the 18 native fixture failures above. The shell oracle tests the adapter's generated POSIX grammar before the native terminal bridge; it does not qualify that bridge, actual Claude permission approval, provider continuity or a full daemon suite.

## Restore instruction selection, prompt and exact read grants (2026-11-02)

Daemon extra-file selection, restore prompt construction and managed read grants now share the same explicit home-prefix resolver. It expands `~/` and the two OPENRIG_HOME forms, plus native backslash forms on Windows, using the selected daemon home rather than an unrelated cwd. POSIX backslashes remain literal. Arbitrary environment variables are not expanded. The permission remains an exact file grant; neighbouring files are not granted.

Six new prefix cases reproduced the missing expansion and now verify the selected path, actual prompt text and exact permission pattern. Native prefix tests passed 6/6, the full enforcer file passed 61/61, and the previously qualified hook file passed 25/25. The expanded native managed-read test file still fails 18 of 19: it invokes `/bin/sh` or expects POSIX-only path/prompt spelling. These are retained failures, not skips or an all-green claim. Four complete corresponding WSL files passed 111/111; daemon typecheck passed. Native managed-read fixture adaptation, full same-head acceptance and actual provider continuity remain pending.

## Native compaction instruction paths and per-seat restore maps (2026-11-02)

The shipped PreCompact hook now expands Windows backslash forms of `~`, `${OPENRIG_HOME}` and `$OPENRIG_HOME` prefixes. POSIX retains literal backslash semantics. Actual hook subprocess tests reproduced all three native failures before the change and now verify restored instruction bytes without launching a provider.

The same audit found two explicitly quarantined restore-map cases: the existing bridge reads an optional restoreMapPath, but the hook never wrote it. The hook now records an existing readable per-seat map only after its declared-seat check; absent, unreadable or foreign-seat maps yield null. Global configured paths are not promoted to per-seat maps. The generated packet and instruction fields remain intact. Enabled regressions verify both old cases, wrong-seat refusal, and actual bridge delivery of the selected path.

The complete PreCompact hook file passed 25/25 on native Windows and 25/25 on ordinary-user WSL, with no skips. Fixtures use owned synthetic transcripts, homes, map files and packet directories and remove them afterward. The public home-prefix inventory checked 1,512 production/resource JS/TS files with the private exclusion applied before reads; it is a syntax inventory rather than proof that every path form is portable. Real provider compaction continuity, active runtime deployment and the complete daemon suite remain unqualified.

## Home-relative plugin plan through real adapter projection (2026-11-02)

The real-filesystem plugin projection fixture now starts from an authored home-relative reference, passes it through the production planner, and gives that resulting plan to both Claude and Codex adapters. Windows uses the native backslash spelling; POSIX uses slash spelling. It checks every nested manifest, hook, skill and README byte in both runtime-specific destinations and the unchanged source tree. The case now runs on both platforms instead of being Windows-only.

The complete adapter-plugin and plugin-planner files passed 23/23 on Windows and 23/23 on ordinary-user WSL. HOME/USERPROFILE are redirected to an owned fixture root and restored before its removal. Initial spying on the built-in homedir export did not affect the planner's imported binding; that failed fixture attempt is superseded by the environment-backed filesystem run. This qualifies actual synthetic plugin copying, not provider loading, hook execution, external plugin installation or an active seat deployment.

## Native home-relative plugin references (2026-11-02)

The plugin projection planner now expands `~\plugins\...` on Windows, matching its existing `~/plugins/...` behavior. Previously the native spelling resolved beneath the declaring spec's literal `~` directory. POSIX keeps backslashes as filename content, and explicit `~user` names are still not expanded. A new planner regression reproduced the Windows mismatch before the fix and checks both platform interpretations.

The two complete plugin/general projection files passed 34/34 on Windows and 34/34 on ordinary-user WSL; daemon typecheck passed. Five existing Windows failures in these files were POSIX-only expected path spellings; their assertions now use native rooted paths while preserving the configured-home versus later-shell discriminator. The tests plan synthetic resources without installing plugins or changing any running seat. Actual native plugin installation and whole-daemon acceptance are not qualified by this result.

## Previously skipped seat-route interaction (2026-11-02)

The empty skipped seat-route case is replaced with an actual memory-router render of SeatScopePage and LiveNodeDetails, a synthetic node-detail API response, and Overview/Details clicks that assert body replacement and an unchanged URL. It targets the current two-tab page rather than the retired outer three-tab definition. The old export-shape assertion is now labelled accurately instead of claiming a direct component render.

The complete topology-view-mode file passed 19/19 on Windows and 19/19 on ordinary-user WSL; UI typecheck passed. The fixture uses a stopped infrastructure node and verifies the exact node-detail request. Both hosts report jsdom's unimplemented canvas context during xterm import, so actual terminal rendering and a deployed browser are not accepted by this fixture. This test-only change follows the `20e601f` complete UI run; it is not a renewed full-directory run at the newer head.

## Complete UI comparison after native path fixes (2026-11-02)

At `20e601f30915cd97c8947035d10adebc590432c3`, the complete UI directory passed 1,836 tests with zero failures and one pending scenario on both native Windows and ordinary-user WSL. All 545 tracked public UI files matched the selected native source and remained unchanged before/after; native head and tracked diff also remained unchanged. The retained reports have SHA-256 `317c199dd77dbce22010a9035f3d5f64036257a870de2c5b3b6f1dd195f91735` (Windows) and `7d3365585fddeb74ccb910b9c523dd7a0958f5866d3dcf2ff3d0075759e6d31e` (WSL).

The pending topology seat-route scenario is not counted as accepted. This renews complete UI-directory evidence after the review-media and StoryGraph native-path changes; it does not qualify other packages, whole-checkout identity, a deployed browser or the running main instance. Both runs emitted the existing Browserslist-age and empty Tailwind-content warnings.

## Legacy argument oracle follow-up (2026-11-02)

The pending oracle fixture now advertises the required privateConfig capability and throws if the no-assignment native branch unexpectedly writes a file. Its coverage inventory uses the TypeScript syntax tree to require every explicit legacy override, rather than treating native-only argv calls as shell-string branches. Probe creation and guarded rollback, targeted native server options and native no-assignment forwarding are now driven too. Every recorded shell invocation is still unquoted by a real `/bin/sh` and compared word-for-word with argv.

The six complete adapter/routing files now pass 261 with one Windows-only skip on ordinary-user WSL. This resolves the two scoped WSL failures above; it does not establish exhaustive branch coverage, renew the whole daemon suite or qualify native-only commands through a POSIX shell. Production source is unchanged by this test follow-up.

## Parent-environment removal ordering regression (2026-11-02)

The respawn fixture now checks the actual ordering contract: inspect global environment first, remove exactly the three inherited identity names, then respawn without `-k`. Independent removals may enumerate differently on Windows and POSIX. The full adapter file passed 160/160 on Windows and 159 with one native-only skip on WSL. Production behavior is unchanged.

The separate exhaustive argv/legacy validation remains incomplete. Its pending local follow-up adds probe creation/rollback and identifies explicit legacy overrides through the TypeScript syntax tree, but its synthetic advertised-native-protocol fixture lacks the required privateConfig writer. That failing experiment is not a passing acceptance result and has not been included in this commit.

## Scoped psmux targets versus literal command data (2026-11-02)

The native routing mapper now reads only the command's first target operand and rewrites only that operand. Previously it searched every argument and replaced every matching scoped identifier: a user option value could select an unrelated server, or be shortened to a bare pane ID. Boolean `-s` flags remain distinct from detach-client's source-session operand, and an explicit `--` bounds target parsing.

New regressions first reproduced both literal-value failures, then passed for ordinary and scoped targets and boolean server/session flags. Six complete native adapter files passed 258 with four platform skips. The same six WSL files passed 259, failed two and skipped one: the existing parent-environment fixture disagrees about removal ordering, and the exhaustive legacy-string oracle does not drive all current run() sites. Those failures remain open; this is not a green cross-platform comparison. Daemon typecheck passed.

An additional real stock psmux 3.4.0 test passed against two independently selected namespaces with equal session names. Each stored and read back a complete routing-shaped option value, retained its receiver output, and survived the sibling's stop; owned sessions and directories were cleaned. No existing team or main runtime was changed. Concurrent server-name exchange atomicity and literal-pipe session-name support remain unqualified.

## File-transfer state wall at filesystem roots (2026-11-02)

The local transfer deny wall now preserves an existing trailing root separator when checking descendants. Previously a configured drive-root OPENRIG_HOME produced a doubled separator and allowed child paths through the lexical check. The new regression reproduced that failure and now requires the existing active-state refusal. Ordinary custom homes, credential-directory denials and directory-content trailing separators remain covered.

Validation: the complete file-transfer test file passed 44 on Windows with three installed-rsync cases skipped, and 47/47 on ordinary-user WSL; CLI typecheck passed. The fixture changes OPENRIG_HOME only in its test process, restores it afterward, and creates no files at the filesystem root. This does not qualify native rsync availability, remote transfer metadata or installed runtime acceptance.

## Native npm Claude entry identity (2026-11-02)

Recognition of an already running declared npm Claude entry now compares native canonical paths on Windows. A real filesystem regression first reproduced rejection of `CLI.js` when the manifest declares the same file as `cli.js`; the corrected comparison accepts that filesystem identity while refusing a distinct script, a missing file and an unrelated package manifest. No broad case folding or provider authentication was added.

Validation: four complete Windows test files passed five tests, including actual owned Node child process identity and native npm Codex argument/help execution. Daemon typecheck passed. These tests are Windows-specific; no Linux execution, real Claude provider conversation, deployed runtime or complete daemon suite is qualified by this result.

## Bundle archive-relative manifest paths (2026-11-02)

The shared archive-relative path predicate now rejects Windows drive-qualified/drive-relative paths and NUL in addition to its existing forward-slash archive grammar, parent/dot/empty-segment and backslash restrictions. Both legacy and pod-aware manifest validation use the corrected predicate. Archive paths remain distinct from host-native paths.

Validation: complete bundle-type, archive and pod-assembler files passed 177 with one platform skip on Windows and 178/178 on ordinary-user WSL; daemon typecheck passed. New cases verify legacy rig/package/integrity-key and pod rig/agent fields. This does not qualify a newly installed tarball or a complete daemon suite at this source version.

## Manifest and library relative file paths (2026-11-02)

Agent-image and context-pack manifest parsers, the agent-image install content map, and context-pack file resolution now reuse the existing authored-relative-path validator. Drive-absolute, drive-relative, UNC/rooted-backslash and NUL paths receive the existing structured domain errors rather than passing a partial slash-only check. Parent-segment rejection and ordinary dotted relative filenames remain supported. Invalid install content paths are rejected before creating the image directory.

Validation: seven complete parser, installation, library and route test files passed 111/111 on Windows and 111/111 on ordinary-user WSL; daemon typecheck passed. No new symlink, concurrent replacement, installed-package or deployment qualification is claimed.

## Review media and StoryGraph native artifact paths (2026-11-02)

Review composition and frozen exports now share a bounded media-reference mapper. Drive/drive-relative and UNC refs, NUL and parent traversal beyond the slice are rejected consistently. A native absolute ref is rejected even when it names a real image inside the slice: authored media remains relative. Windows relative separators normalize to the transport form; ordinary POSIX literal-backslash filenames retain their actual filename semantics. Existing artifact-relative parent refs that stay inside the slice remain supported.

StoryGraph now extracts complete drive/UNC and Unicode artifact paths instead of dropping drive letters and backslashes. Quoted paths can contain spaces. Its existing file drawer opens the original absolute path; drive-relative refs remain inert, and HTTP/file URLs are not mistaken for local artifacts.

Validation: four complete composer, freeze, StoryGraph and server-path files passed 134 with one platform-specific skip on both Windows and ordinary-user WSL. The skipped cases differ by platform. Actual freeze routes refuse non-relative media, the POSIX run inlines a real literal-backslash filename, and component clicks retain exact native artifact targets. Daemon and UI typechecks passed. This is newer source than the `5d74d11` complete UI run and is not a renewed full-directory or deployment claim.

## Complete UI directory regression follow-up (2026-11-02)

The complete UI directory at `319eb4e` reported 1,822 passed, ten failed and one pending natively, and 1,826 passed, six failed and one pending on WSL. All 545 tracked UI files matched across the two runs; the WSL source hashes stayed unchanged. Failures exposed current-directory assumptions in source/asset tests, an LF-only route assertion, direct execution of the extensionless tsx shim on Windows, and English-only calendar assertions on a Chinese-locale host.

Tests now anchor source/asset paths at their test directory, accept CRLF route source, and execute the real tsx JS entry through Node with the existing bounded child-render guard. Date assertions require localized month/day fields instead of forcing English; production formatting is unchanged. Seven complete follow-up files passed 84/84 on both Windows and WSL. This does not substitute for the final complete UI directory rerun or deployed-browser acceptance.

## Native workspace mission discovery (2026-11-02)

Filesystem mission discovery now reuses the scope allowlist resolver instead of a separate POSIX-only prefix implementation. A Windows workspace below an allowlist root, including UNC and mixed-separator/exact-root spellings, requests the correct relative missions directory. Workspace labels use the daemon path syntax for their basename and preserve literal backslashes in POSIX names. The existing remote-selection gate still disables local filesystem requests.

Validation: complete ProjectTree mission-discovery, server-path and scope-markdown files passed 46/46 on Windows and 46/46 on ordinary-user WSL; UI typecheck passed. The actual ProjectTree tests assert discovered nodes and file-list request paths. This does not qualify a physical network share or deployed browser.

## Scope reading, file drawer and evidence path grammar (2026-11-02)

Scope-markdown and the file drawer now share the browser-safe daemon-path mapper. Windows native child paths, mixed separators and UNC share roots resolve to slash-separated API read paths; POSIX literal backslashes remain filename content. Exact-root scope selection and the deepest matching root remain supported, while a file drawer does not attempt to read the root directory itself. Redundant POSIX-only scope prefix helpers were removed.

Evidence openers now reject Windows drive/drive-relative, UNC, backslash parent segments and NUL refs before constructing a viewer or asset URL. Ordinary dotted child names remain valid. The file service remains authoritative for physical containment and symlink checks.

Validation: seven complete UI files passed 67/67 on Windows and 67/67 on ordinary-user WSL; UI typecheck passed. Tests verify actual scope-hook and file-drawer API requests, POSIX literal-backslash reads, native drive/UNC scope resolution, non-openable invalid evidence refs, prior Agent/library navigation, and existing scope loading/error states. React review found no new hooks, effects, requests or dependencies. This is component/request-level acceptance, not deployed browser, physical UNC-share or concurrent-filesystem acceptance.

## Complete CLI directory result and canonical fixture follow-up (2026-11-02)

The complete native CLI directory at `6a40322` reported 6,302 passed, four failed and 96 pending tests. Head and tracked diff remained unchanged throughout. Three failures supplied JavaScript-realpath fixture spelling to a native canonical file allowlist: protected file-editor access, MCP queue artifact reading, and MCP external-grant artifact reading. These fixture producers now use native realpath on Windows. Their three complete files passed 48/48 natively; WSL passed 25 and skipped the 23 native ACL cases.

The remaining Windows Terminal system-discovery test is unresolved. Its real where.exe call cannot find an owned wt.exe witness under the test's otherwise empty PATH. A child Node process confirmed one matching PATH key and the witness's existence; independent native probes found the witness across PATH-key, directory-case and PATHEXT variants. No cause is established by that difference. The assertion now retains the actual lookup error rather than only an abbreviated failure object. No window is launched by this fixture, no production workaround or skip was added, and no whole-CLI green claim is made. Repeated undifferentiated attempts were stopped; further work needs new evidence about the fixture/native invocation difference.

## Review export allowlist mapping (2026-11-02)

Review export directory mapping now canonicalizes Windows paths through native realpath, matching the file service's allowlist namespace. Its prefix boundary also preserves an existing terminal separator, so filesystem-root allowlists work instead of constructing a doubled separator. Different directories remain outside the mapping.

Validation: the complete review-freeze file passed 15/15 on Windows and 14 with one native-only case skipped on ordinary-user WSL; daemon typecheck passed. Tests cover filesystem-root mapping and a Windows case alias, alongside the route-level freeze/export cases. This is not a concurrent filesystem replacement or deployment qualification.

## Native CLI entry identity (2026-11-02)

Both the source index and bin wrapper now use native realpath for their Windows direct-run identity check. A case alias of the same file previously compared unequal through the JavaScript realpath implementation and could leave the entry inert. POSIX resolution remains unchanged, and a different file still does not qualify as the current module.

Validation: the two complete entry test files passed 12/12 on Windows and nine passed with three Windows-only cases skipped on WSL; CLI typecheck passed. Actual normal and uppercased-directory invocations of both source entries through tsx returned 0.7.1 under an owned synthetic home. The bin wrapper used its existing paired dist, so this is not a fresh installed-package qualification. An all-uppercase `.TS` extension was separately refused by the tsx/Node loader before entry execution; that loader behaviour is not claimed fixed.

## Preflight configured directory permissions (2026-11-02)

Preflight now checks the configured database parent and transcript directory even when they sit inside OpenRig home. The old POSIX-only prefix shortcut skipped child permissions on Linux while backslash paths typically caused Windows to check them. Parent writability does not establish child writability. Each resolved directory is checked once, and existing native create-without-overwrite probes remain in use.

Validation: complete preflight, quiet-exec and native doctor-writability files passed 27/27 on Windows; ordinary-user WSL passed 24 with three Windows-specific cases skipped. Real fixture permissions deny each nested directory separately: preflight fails with its path, succeeds after restoring permissions, and leaves no write probes. CLI typecheck passed. This does not establish subsequent database or transcript operations against concurrent permission changes.

## Feed native evidence and project continuity (2026-11-02)

Delivered-update evidence now recognizes fully qualified daemon Windows drive and UNC paths alongside POSIX paths, regardless of the TUI host. Drive-relative refs, relative paths and URLs are not invented as absolute file targets. Attention source navigation uses the existing server-path root mapper for project membership, replacing the POSIX-only string prefix. Exact served-source validation remains mandatory, sibling directories do not inherit the project, anchors are retained, and Back restores the caller. Queue project tags alone still do not create project authority.

Validation: complete Attention, Feed-system and reading-journey files passed 29/29 on both native Windows and ordinary-user WSL; TUI typecheck passed. Drive, UNC and mixed-separator navigation, outside-sibling rejection and unserved-path refusal are covered. Final whole-directory validation remains separate.

## TUI directory regression follow-up (2026-11-02)

The complete native TUI directory at `a9d2e39` reported 1,212 passed, 11 failed and 19 pending tests. Reading-journey and literal-argument fixtures supplied non-native TEMP spelling to the canonical file allowlist; they now use native realpath on Windows. The actual viewer C# source was separately compiled with inherited versus owned compiler temp: inherited global TEMP failed to supply its transient source, while the owned directory compiled successfully. Viewer environment reads now create and remove a unique compiler directory and pass its TEMP/TMP explicitly, excluding inherited case variants. The real signal fixture likewise uses its owned root for compiler temporary files. The cause of the host's global TEMP behaviour remains unknown.

After these changes the four failing test files passed 24/24 natively, including real launch-group SIGINT/return/normal SIGINT and allowlisted environment reads from a live own-user client, followed by refusal after exit. WSL passed 18 with six Windows-only viewer cases skipped. TUI typecheck passed. This follow-up does not replace a complete directory run on the final changed version.

## TUI long native source labels (2026-11-02)

Long Windows source paths now shorten by native or mixed path segments instead of collapsing to an empty ellipsis label. A single oversized filename retains its suffix. POSIX literal backslashes remain filename content. The original full path stays in the file-open action; display shortening never rewrites the target.

Validation: the complete render-regression file passed 20/20 on Windows and 20/20 on ordinary-user WSL, including drive, UNC, long basename and POSIX literal-backslash cases; TUI typecheck passed. Two native runs first failed in test setup because PowerShell CodeDom could not find its transient source in global TEMP. Compiler TEMP/TMP now point to the owned stub fixture directory, with inherited case variants removed; the subsequent native run prepared and passed. The original transient-file disappearance is not attributed to a proven host cause. These tests qualify rendered text and action data, not physical desktop acceptance.

## Browser references to native daemon paths (2026-11-02)

Agent startup-file chips and library rig member drilldowns now resolve references using the daemon source path's syntax, independently of the browser host. The shared browser-safe resolver handles drive paths, UNC shares, extended drive/UNC prefixes, native or mixed separators and parent segments without climbing above the drive/share root. Drive-relative Windows refs are unavailable because the browser has no per-drive working directory. POSIX backslashes remain literal filename characters. Library lookup compares normalized whole segments and preserves case distinctions.

Validation: three complete UI test files passed 25/25 on both Windows and ordinary-user WSL. Tests click actual Agent file chips and verify drawer selection targets; library tests click through actual member drilldowns for POSIX, drive and UNC sources. UI typecheck passed. React review found no new hooks, effects, fetches or dependencies; resolution stays a pure module function, and existing button interactions are retained. This is component-level acceptance, not a deployed browser or real network-share qualification.

## Dotdot-prefixed child path handling (2026-11-02)

Home-isolation advisory checks, the native Pi npm entry resolver, and the dependency-root gate now distinguish an actual parent segment from a legal child whose name begins with two dots. Consistently isolated `..seat` and `..codex` paths no longer produce false advisories; a recognized npm shim can launch its package-owned `..dist/cli.js`. Actual parent and sibling traversal remains rejected. The gate accepts a lock-derived `packages/..cli` workspace target while rejecting its parent and outside sibling.

Validation: both complete daemon test files passed 17/17 on Windows and 16 passed with one Windows-only skip on WSL. The complete native dependency hermeticity file passed 9/9; its new filesystem boundary case also passed under WSL. Daemon typecheck passed. Startup fixtures logged blocked external plugin fetches with vendored fallback; the Windows run also logged a closed-database degradation callback during fixture teardown. These runs qualify the stated path behaviour, not clean daemon lifecycle acceptance or full parity.

## Operating posture project boundary (2026-11-02)

The operating posture reader now checks parent traversal using the native path separator. Previously its POSIX-only `../` comparison missed Windows `..\` relative paths when an authored mission root pointed outside its selected project. A filesystem regression selects the neighbouring project's mission directory and requires an unknown posture with the explicit escape reason. Test roots and canonical expectations use native realpath on Windows to preserve actual disk spelling.

Validation: the complete operating-posture test file passed 22/22 on native Windows and 22/22 under the ordinary WSL test user; daemon TypeScript checking passed. This is scoped validation, not whole-suite parity or deployment acceptance.

## Current native progress scanning and path classification (2026-11-02)

Progress scanning now matches its filenames and excluded dependency/build
directories case-insensitively on Windows, in parallel with the existing spec
scanner. POSIX names remain case-sensitive. Native scan-root decoding records
the filesystem's actual spelling. Steering canonicalizes its selected lane root
and keeps Mode-N/PROGRESS filename variants on the canonical mode-n lane ID;
failed root resolution is reported as an unavailable source.

The pure UI rail classifier selects Windows case rules from the daemon file's
canonical drive/UNC path syntax, not the browser host. The existing payload is
sufficient; no API field was added. Tests cover mixed-case mission/lane/slice
paths, POSIX counterexamples and Windows drive/UNC/extended-prefix spellings.
A real native scan was passed to that helper, and a real Steering fixture kept
its mode-2 ID and canonical file path. These are helper/API tests, not rendered
browser acceptance. Three focused files passed 54 native checks and 51 checks
in the ordinary-user WSL mirror (3 native-only skips). Daemon and UI TypeScript
checks passed. Main deployment and existing teams were unchanged.

The reviewed bundle source already uses native canonical paths and relative
containment checks. A separate actual Git 2.51.2.windows.1 configuration probe
confirmed that bundleGit ignored owned global/XDG witnesses and retained its
HTTPS-only and hooks-path policies with its existing /dev/null configuration.
An additional actual bundleGit probe received a synthetic Basic-authentication
challenge from an owned loopback HTTPS server. It refused in 53 ms after one
request with no Authorization header; the server and synthetic certificate/key
were removed. This qualifies noninteractive authentication refusal on this host,
not successful authenticated fetches or hook execution. No change was made merely for a POSIX-looking
Git-specific path string. The comprehensive path audit remains in progress.

## Current file-browser root boundaries and native canonical spelling (2026-11-02)

Local roots now preserve an existing trailing separator, so an allowlisted
drive root or POSIX filesystem root matches its configured descendants. Windows
allowlist decoding, file resolution and local-root presentation use native
realpath spelling: JS realpath was experimentally shown to retain arbitrary
input casing on this host, which incorrectly rejected internal file aliases.
This keeps strict canonical boundaries without blindly case-folding distinct
directories. The production startup producer uses the shared allowlist decoder.
Windows drive-relative reader requests and embedded NUL are rejected early.

The local reader also recognizes its direct entry through a native parent
directory link. Real fixtures cover a drive-root selection, mixed-case and
extended-prefix root spellings, an internal file alias, an escaping alias, and
an actual Node subprocess started through a linked parent. That subprocess
returned the expected roots JSON, and its owned link was removed separately.
Four old HTTP fixture groups were updated to supply actual canonical native
roots, preserving their read/write/conflict/audit/media/truncation assertions.

Six focused files passed 72 native checks (1 POSIX executable-mode skip) and
69 ordinary-user WSL checks (4 platform-specific skips). Both package TypeScript
checks passed. The CLI's paired daemon dependency was transpiled for this one
reviewed module in the task checkout/mirror; no full package build or deployment.
Network UNC shares and filesystem-identity races are not qualified by these
local fixtures. The broad path audit and whole same-head suite remain open.

## Current authored relative-path validation (2026-11-02)

The byte-identical CLI/daemon safe-path validators now reject drive-relative
spellings such as C:foo and a bare drive selector. Those resolve against the
drive's current directory, not an authored bundle root. Embedded NUL is rejected
before filesystem use. Existing absolute/UNC/extended-prefix and traversal
refusals remain, and ordinary relative Unicode/space spellings are unchanged.
The consumer audit covers agent resource paths, startup references, rig schema,
export references and the permission-policy twins. Three selected files passed
75 tests on Windows and 75 in the ordinary-user WSL mirror; both package
TypeScript checks passed. This is the authored relative-path grammar, not a
claim that every accepted spelling is representable on every filesystem.

The old 0b0df4c full CLI/TUI receipt's three failing files (doctor, file-command,
lazy-program) subsequently passed all 70 of their current native checks. That
closes those old failures for this targeted source run; the complete current
CLI/TUI directory suite and broad path audit remain unfinished.

## Current case-distinct resource paths and legacy compatibility (2026-11-02)

Ordinary resource IDs now encode uppercase and Unicode characters on Windows,
so fresh Skill/skill and Unicode case variants have distinct native directories.
Lowercase ASCII paths remain stable. An exact legacy directory is retained in
place, including its edits; a new lowercase identity colliding with another
legacy spelling gets a reversible escaped alias instead. Long aliases use the
existing compact Windows representation. Duplicate identity spellings and
non-directory/link occupants are refused without modifying either entry.

Projection, cwd preparation, conflict planning, runtime-switch materials and
seat replay share this path selection. Installed-resource discovery decodes
both canonical and alias names. Missing legacy files retain their recorded
resource identity during replay rather than substituting today's source at a
new path. Git hygiene resolves the actual core-plugin directory and keeps a
different legacy identity visible. No legacy directory is moved or linked.

The expanded native projection/storage selection passed 150 checks in 11 files;
runtime-switch/Git hygiene passed 36 checks, followed by the added native alias
case alone (1 passed, 29 other cases not selected). Seven selected current-source
files in the ordinary-user WSL mirror passed 75 checks with 21 native-only skips.
Daemon TypeScript passed. Real filesystem fixtures cover all four provider
adapters, edited legacy directories, maximum-length native components, links,
duplicate identities, listing, conflict paths and missing-source replay. These
are projection/storage checks, not provider launch or a full same-head suite.

A separate user-authorized path audit inventoried 3,900 tracked public source,
asset, script and test files, excluding the private source and protected
diagnostic before reads. It found 290 production and 731 test candidate files;
those are static matches requiring semantic review, not confirmed defects or a
completed full audit. The old 0b0df4c CLI/TUI receipt has 3 failures and is not
evidence for this newer source. Main deployment and original teams are unchanged.

## Current resource directory device names and open case collision (2026-11-02)

Resource directory encoding now includes the six superscript COM/LPT device
names, with extension and case variants. Microsoft documents superscript
digits 1/2/3 as reserved in these names in every directory:
https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file .
The resource identity itself and POSIX path spelling remain unchanged; only
its Windows directory representation is escaped reversibly. The resource
projection file passed 16 native tests, including actual creation/readback of
12 escaped directories. The selected current mapper/test in the WSL mirror
passed 2 pure mapping checks with 14 native filesystem/projection skips, and
daemon TypeScript passed.

An earlier owned fresh-directory probe established an implementation
gap: unqualified `Skill`/`skill` and Unicode upper/lower resource IDs mapped to
case-aliasing native paths. Both second mkdir operations returned EEXIST, with
the first identity's bytes unchanged; the probe directory was removed. The current
case-distinct resource-path receipt above supersedes that ordinary-ID limitation
for its tested projection/storage scope, including legacy edits and replay.
No main instance was touched.

## Current native terminal activity (2026-11-02)

A native terminal seat no longer reports running merely because its pane
command names PowerShell, pwsh, cmd or another known shell host. Such a host
needs the existing stable, own-console receiver/lineage proof before that
activity fallback can report running. An absent, ambiguous or unreadable
receiver remains unknown, never an invented idle observation. POSIX command
classification and direct non-shell foreground commands retain their behavior.

An isolated stock psmux 3.4.0 pane actually returned unknown for its empty
PowerShell prompt and running after an owned Node command started. The direct
busy observation named node; the shell-host-with-child proof path is separately
covered with controlled receiver inventories. The test command uses a script
file after two inline fixture attempts produced no startup receipt; their cause
was not established. Owned child/session/console cleanup passed. Four focused
daemon files passed 69 tests on Windows and the ordinary-user WSL mirror, and
daemon TypeScript passed. This is scoped activity evidence, not a complete
provider/foreground-job-control or same-head platform acceptance claim.

## Current native tile server routing (2026-11-02)

The Windows reattachment asset now sends the original exact session name as
psmux's first target on every snapshot, identity and attach command. The later
immutable `$N` remains scoped to that session server rather than selecting a
default server, where the same numeric ID may identify another seat. Exact
server options, literal argv, read-only/ignore-size flags and bounded following
remain in use.

The actual asset was launched in an owned hidden console against stock psmux
3.4.0 with two live session servers and an intentionally conflicting inherited
default. Its new client appeared only on the intended server, in read-only mode;
the other server's client inventory was unchanged, and owned cleanup passed.
This proves that initial routing case, not an atomic server-identity guarantee
during a concurrent registry/name exchange. Three focused daemon files passed
45 native tests (1 POSIX-only skip) and 43 ordinary-user WSL tests (3 Windows-only
skips). Neither the main deployment nor any existing team was changed.

## Current native multi-server attachment proof (2026-11-02)

Herdr workspace reuse now queries each distinct local psmux target session with
the daemon's exact server options. POSIX tmux retains its single-server client
inventory. A native result from another session, a missing client, an unavailable
server, a reused PID across tiles, or a read-only mismatch cannot prove reuse.
Windows executable paths are interpreted using Windows path semantics even in
cross-platform fixtures; CRLF client rows are accepted.

An isolated stock psmux 3.4.0 acceptance ran two real hidden-console clients on
separate session servers (one writable, one read-only). The production attachment
proof queried both exact sessions and matched their actual PIDs; only Herdr's
pane/process inventory was supplied by a fixture. Both session process cleanup
and owned-directory cleanup passed. Thus native client matching is qualified on
this host, while actual Herdr desktop workspace reuse remains unqualified.
The native window-action set passed 248 tests with 13 POSIX-only skips; selected
current CLI source/tests in the ordinary-user WSL mirror passed 83 with 1 native
tool-lookup skip, and CLI TypeScript passed. No full-current-head parity claim.

## Current piped native hosting width (2026-11-02)

The Windows CLI now measures its hosting psmux window when stdout is piped,
instead of immediately treating the viewport as unknown. It preserves the
caller's environment snapshot separately from the detached launch environment
and uses the full inherited psmux server identity. Missing/invalid pane identity,
invalid width, an unavailable executable or a failed query remain unknown.
An owned stock psmux 3.4.0 hidden-console client returned the same 120 columns
through the actual piped CLI dependency path as the server query; cleanup passed.
The focused CLI files passed 78 native tests and 77 ordinary-user WSL tests
(1 native executable lookup skipped), and CLI TypeScript passed. The expanded
native window-action set passed 242 tests with 13 POSIX-only skips. These results
do not qualify piped native console callers outside psmux or a full-current-head
Linux run, and do not establish actual Herdr desktop rendering.

## Current shared native TUI viewer recovery (2026-11-02)

Windows shared TUIs now recover Herdr/Rex terminal markers from their unique
last-active non-control psmux client. The inherited `PSMUX_TARGET_SESSION` pins
the full namespace/server identity; a bare pane ID never selects a server.
The selected client's own-user token and same-bitness x86/x64 process layout are
checked before reading its environment. Only terminal marker names leave the
bounded native helper. Missing/unreadable/unsupported clients, tied activity,
and a viewer change during the read return unknown without choosing another
client. Linux keeps its `/proc` path and gains the post-read selection check.

On this Windows x64 host, three focused files passed 59 tests with 9 POSIX-only
skips, and the TUI TypeScript check passed. The same selected source files in
the retained ordinary-user WSL mirror passed 61 with 7 native-only skips; this
is not a whole-current-head WSL run. An owned, isolated stock psmux 3.4.0 hidden
console client also passed actual server selection and marker retrieval, with
no private sentinel forwarded and successful process/directory cleanup. This
supersedes the Windows viewer-recovery implementation limitation below, but
does not qualify ARM64, cross-bitness clients, another user's processes, actual
Herdr desktop reuse, or all-platform parity. The main deployment was unchanged.

## Current native TUI marker casing (2026-11-02)

The TUI now interprets inherited terminal marker names case-insensitively on
Windows, matching the CLI. Mixed-case Herdr pane markers retain precedence over
Rex/cmux, and forwarding viewer markers removes inherited marker aliases before
overlaying the selected viewer. POSIX environment-name semantics are unchanged.
Native `open-window.test.ts`: 40 passed, 9 POSIX-only skipped; TUI TypeScript check
passed. This does not qualify recovery of a shared psmux client's environment:
that remains unimplemented on Windows. Remote real Pi OAuth continuity is deferred
by the user pending login on the second host; it is not counted as passed.

## Current reading guide (2026-11-02)

The tables below are the historical initial map, not the current remaining-work
list. Later dated receipts supersede their older limitations only for the exact
tested scope. In particular, developer-mode symlink checks, the owned local Pi
and service snapshot/restore, real SSH disconnect survival and request-bound
shutdown, and ACP companion fixture teardown have passing follow-up evidence.
Their earlier failures are not current blockers for those tested paths.

Current source follow-ups add Windows per-home psmux server selection, keeping
the previous server while registered sessions remain or observation is unknown;
and ordinary Windows file-copy planning for binary SFTP Unicode/space paths and
absolute `/C:/` roots. These are implementation and scoped verification, not a
full same-head platform acceptance result. The corresponding receipts are below.

Remaining implementation/contract work includes terminal-backend behavior mapping
and file-transfer archive metadata semantics. Stock initial/respawn privacy now
has the scoped passing implementation below; arbitrary shell/hook behavior and
complete same-head runtime acceptance remain separate requirements.
Remaining acceptance includes same-head full Windows/Linux comparison, remote
real-provider continuity after renewed Pi OAuth login, other harness lifecycles,
foreign-user daemon access, supported runtime/architecture/job-policy matrices
and reboot/suspend/power-loss behavior. Latest source changes are not deployed to
the existing main instance. No overall parity claim is made.

## Current open requirements (2026-11-02)

### Current native Herdr endpoint selection (2026-11-02)

The default Windows CLI window path now retains an already marked Herdr context
instead of bypassing it for a new Windows Terminal window. TERM_PROGRAM=herdr
or the complete Herdr pane-marker trio selects the existing Herdr path; native
case-insensitive environment normalization applies before selection. Explicit
tmux still selects Windows Terminal, and inherited Rex markers keep that native
default. Preview composition remains the Herdr plan used by both window paths.

Two native-context fixtures confirm that a stale expected plan is refused on
the Herdr path without Windows Terminal lookup, configuration writes or provider
mutation. The ordinary common-path suite covers create/reuse/focus, while a new
explicit-tmux fixture covers the Windows override. The two files pass 64 checks
on Windows and 63 on the ordinary WSL mirror, with the real native tool lookup
skipped on WSL. CLI TypeScript checking passes. This is route/guard qualification,
not a new real Herdr desktop acceptance result. Windows last-active-client
marker recovery was subsequently implemented and tested in the current shared
native TUI viewer recovery receipt above.

### TUI native window preview/launch selection (2026-11-02)

Windows TUI terminal previews now use the same Herdr-composed plan as the
existing native CLI window launcher. Inherited Rex/cmux markers no longer
select a different preview or route the Windows open action through cmux.
The selected daemon, view and expected-plan token are preserved. This aligns
the available native window path; it does not qualify Windows Rex/cmux GUIs.
POSIX marker-based provider selection remains covered independently.

The complete TUI opener and two Windows CLI window/preview files pass 57 tests
on Windows, with nine real POSIX viewer cases skipped. The exact changed TUI
source/test in the ordinary WSL mirror pass all 47 opener checks, including
those POSIX cases. TUI TypeScript checking passes. Child CLI fixtures record
literal argv and selected endpoint; no actual desktop window is opened by these
tests. The subsequent shared native TUI viewer recovery receipt above supersedes
the former Linux-only viewerTerminalEnv implementation limitation.

### Native local type-exchange recovery and no-clobber moves (2026-11-02)

Windows local exchanges now use MoveFileEx without REPLACE_EXISTING for backup,
installation and recovery, including the local SFTP endpoint's no-replace moves.
This avoids ordinary Node rename overwriting a new occupant during recovery.
Recovery paths are retained before dispatch and their existence is marked
unconfirmed after ambiguous later operations. Local SFTP move failures retain
their local path/syscall classification. The paired daemon helper export is
compiled successfully and CLI TypeScript checking passes.

Six controlled local move-boundary faults pass on Windows and WSL: install
refusal, occupied file, occupied empty directory, post-backup failure,
post-install failure and post-restore failure. They perform actual filesystem
moves/occupant creation and assert original/staged bytes, directory inode and
recovery hints. Pre/post-operation errors are injected at the move boundary,
not actual kernel or OS-crash failures. Windows's preceding three-file run
passed 37 checks with one POSIX-only skip; the final six faults pass separately.
The current four WSL recovery/type/staging files pass 35 tests.

The POSIX fallback uses exclusive hardlinks for non-directories and a mkdir
reservation for directories. It does not provide Windows's one-syscall
directory no-replace guarantee; adversarial replacement of that reservation
and OS-crash durability remain unqualified. These scoped recovery results do
not close complete cross-platform filesystem or archive acceptance.

### Remote SFTP directory-exchange fault qualification (2026-11-02)

SFTP no-replace renames now use the standard RENAME request even when the
server advertises posix-rename; the replacing extension is reserved for explicit
replacement. This prevents recovery from overwriting a new file occupying the
destination. The original recovery path is recorded before its first move is
dispatched, with existence marked unconfirmed until acknowledged. Later recovery
or cleanup dispatches invalidate that confirmation. Failed transfers always have
a nonzero result code, including a transport that closes cleanly before its reply.

A test-only framed proxy wraps actual owned OpenSSH subsystems and injects
seven file-backed upload cases: backup refusal, lost backup success reply,
install refusal, lost install success reply, a newly occupied recovery target,
lost restore success reply, and lost cleanup success reply. All seven pass on
Windows and on ordinary-user WSL. Assertions read actual filesystem state,
retained original bytes, staged/installed directory bytes, and recovery hints.
The occupied target remains unchanged. Five-case Windows SFTP/protocol regression
ran 34 passing checks before the last two scenarios were added; the final seven
fault checks pass separately. WSL's final recovery/staging pair passes 20 tests.
CLI TypeScript checking passes. These are local subsystem tests, not network
SSH, OS-crash durability or all link types. Local-endpoint follow-up is above.

### Staged source-directory replacement of files and links (2026-11-02)

Local and SFTP copies now stage a complete source directory before replacing
a conflicting ordinary file or link. The original entry is moved to a unique
recovery name for the final exchange, then removed after the staged directory
is installed. Failed final exchange attempts restore the original; unresolved
exchange/cleanup exposes retained paths and remains a failed result. Local-endpoint
rename/recovery still needs fault qualification; remote file-backed SFTP phases
have the scoped follow-up above. A failed
source staging pass leaves the original file unchanged and retains the partial
stage. Successful itemized output uses logical destination paths, not stage names.

Windows local checks cover ordinary/readonly files and file/directory links,
including unchanged bytes and readonly mode on a retained hardlink. A former
junction-refusal assertion now verifies replacement of the link itself, with
the referent unchanged. Six real Windows SFTP upload/download checks cover
ordinary files and both link types. Windows OpenSSH needs nonrecursive RMDIR
to remove directory links; nonempty referent witnesses remain unchanged.
The three Windows files passed 51 checks. Current focused WSL tests pass 25,
including bidirectional OpenSSH replacement and source-staging failure retention.
CLI TypeScript checking passes. Independent rsync 3.2.7 checks confirm both
directory-over-file replacement and no-follow directory-link replacement.
Special files, ownership and broader archive equivalence remain open.

### File/link replacement of empty conflicting directories (2026-11-02)

Local and SFTP copies now replace an empty conflicting directory with a source
file; local copies also cover source links. The complete replacement entry is
staged first. Nonrecursive RMDIR is the final emptiness check, so a directory
that gained a child during staging is retained. A subsequent rename failure
attempts to reconstruct the original empty directory and its metadata; recovery
failure remains explicit and the stage is retained for inspection. The rename
failure recovery branch is not claimed as real fault-injection qualification.

Real rsync 3.2.7 confirms successful empty-directory replacement and preservation
of nonempty directories (exit 23). Windows local/SFTP/protocol runs cover four
local file/link cases and six SFTP upload/download cases, including adding a real
child after staging begins: the new child and complete staged bytes survive the
refused removal. The three final Windows files pass 27 tests; the preceding
four-file run passed 39 before those six new cases. The current three focused
WSL files pass 16 tests against an ordinary-user OpenSSH subsystem. CLI
TypeScript checking passes. The directory-over-file follow-up is recorded above;
broader special-file/archive semantics remain separate requirements.

### Existing readonly-directory merge permissions (2026-11-02)

Local and SFTP recursive copies now temporarily add required owner access to
existing POSIX directories before merging children. They apply source directory
metadata afterward even when a child fails, matching the observed rsync archive
behavior rather than leaving temporary owner-write access behind. If final
metadata itself fails, the original borrowed permission mode is restored where
possible and failures remain explicit. Dry-run never changes directory modes.
NTFS directory access is not represented by POSIX chmod bits and remains excluded.

Ten ordinary-user WSL tests cover directory-mode repair, restrictive creation,
existing readonly merge, source-mode finalization after a nonempty-directory
conflict, retained extra entries and SFTP staging/upload/download. An independent
real rsync 3.2.7 comparison confirms mode 0555 after successful merge and source
mode 0750 after a child conflict (rsync exit 23). Native Windows's five complete
local/SFTP/protocol/path files pass 49 tests; CLI TypeScript checking passes.
These are scoped directory-permission results, not full archive equivalence.

### SFTP staging permissions and readonly-directory completion (2026-11-02)

SFTP MKDIR and exclusive OPEN now request 0700 and 0600 respectively at creation;
the local endpoint uses the same initial modes. Final source permissions are
still applied after file data or directory recursion completes. Previously a
real OpenSSH server under umask 000 created a directory as 0777 before its final
metadata pass. The regression reproduces that difference and now passes.

Three ordinary-user WSL/OpenSSH tests check initial directory mode, file mode
before the first data yield, final permission changes, and readonly-directory
upload/download with complete bytes. Independent filesystem observations see
0600 staging files in both directions before final 0640 files and 0555
directories. Windows's complete SFTP/protocol/path files pass 29 tests; CLI
TypeScript checking passes. A separate real Windows-source client to the owned
WSL subsystem passes initial/final mode checks and cleanup, with source hash in
the local sftp-staging-native receipt. This is subsystem protocol qualification,
not a network SSH authentication test or POSIX access enforcement through NTFS
mode bits. Owner/group, ACL and special-file archive equivalence remain open.

### OpenShell real-engine qualification boundary (2026-11-02)

Live PATH checks find neither openshell.exe nor podman.exe on this host. The
official v0.1.6 release asset list contains no Windows native binary. Its
[installation documentation](https://docs.nvidia.com/openshell/v0.1.6/about/installation/)
directs Windows users to build the separate windows branch; Podman is listed
as a Linux runtime. The Windows branch's
[runtime guide](https://github.com/NVIDIA/OpenShell/blob/windows/WINDOWS.md)
explicitly excludes native Docker/Podman/Kubernetes/MicroVM compute backends
and records missing foreground attachment, ConPTY resize and live-generation
gateway-restart recovery for its development-only MXC backend.

The current OpenRig driver uses a Linux Python guest contract. A passing native
CLI fixture or Windows pipe observer therefore does not prove that MXC can
provide that contract. A native client controlling a qualified Linux gateway
and its rootless engine is a separate path requiring real qualification.
An isolated source snapshot of windows commit
e451bb390a3b463724ccf5547b46b9432428690d is retained locally (archive SHA-256
83e13f426240b9f45fb7b75c950e823a97b4126c35c2767fd95207ed8349b049).
The official native build task was run with existing MSVC/Rust and task-owned
outputs. It failed twice with native Rust compiler exceptions: first idna
1.1.0 with 0xc0000005, then opentelemetry_sdk/noyalib, including 0xc000001d.
A separate same-toolchain idna build passed, so that bounded diagnostic does
not establish the cause or completion. Both full attempt logs are retained;
no third unchanged full-build retry is scheduled. No native client artifact,
gateway, sandbox or engine acceptance is claimed. This is a separate compiler
qualification dependency, not evidence of an OpenRig product test failure.

### OpenShell finite native CLI custody (2026-11-02)

The default OpenShell driver now runs finite native CLI clients through the
bounded Windows Job exec wrapper, retaining its 30-second deadline and 2-MiB
output bound. POSIX execFile execution is retained. Unconfirmed replies still
raise openshell_transport_unconfirmed and require reconciliation; the driver
does not retry a possibly applied gateway operation.

Three complete driver/observer/native-process files pass 18 Windows tests.
An owned native CLI stand-in is found by its bare name through PATH and checks
the default driver's literal list argv. Acknowledged detached children are
gone after success, exit 7, timeout and output overflow. The exact changed
driver and current three test files in the ordinary WSL mirror pass 13 tests,
with five Windows-specific cases skipped. Daemon TypeScript checking passes.
This is finite-client custody and existing contract coverage, not an installed
OpenShell/Podman engine or full sandbox-lifecycle acceptance.

### Windows Job executable PATH lookup (2026-11-02)

A direct-versus-Job native check reproduced a missing behavior: `node.exe`
resolved through the selected child PATH with execFile but returned helper exit
125 through CreateProcess. The Job preparation now resolves bare native names
before dispatch, preserving the requested argv0 separately from the resolved
application path. Search follows native current-directory/PATH and .com/.exe
rules rather than invoking a shell or interpreting PATHEXT batch shims; see
[libuv's Windows process search](https://github.com/libuv/libuv/blob/v1.x/src/win/process.c).
Explicit path operands retain their existing path behavior.

Real Windows comparisons pass for `node`, `node.exe`, and a quoted PATH entry,
including exact argv0 and executable identity. The complete Job, installer,
Herdr native CLI and Rex native process files pass 24 tests, and daemon
TypeScript checking passes. This closes the tested bare-name lookup gap; it
does not establish a real package installation or OpenShell engine lifecycle.

### Herdr finite native CLI custody (2026-11-02)

Herdr viewer control commands and local seat identity inspection now execute
inside the existing atomic Windows Job launcher. The bounded native exec wrapper
retains captured environment, stdout/stderr and exit codes; timeout or output
overflow ends the owned Job and reports that command outcome may be unknown.
The POSIX execFile path remains unchanged. Persistent viewer/server launch is
not routed through this finite-command wrapper.

Five viewer/follow/native-process files pass 63 Windows tests. Four real owned
native CLI fixtures cover acknowledged detached-child cleanup on exit 0, exit
7, timeout and output overflow, plus literal argv and selected-socket isolation.
The CLI-runner/native-process pair passes three POSIX runner cases in the ordinary
WSL mirror, with four Windows process cases skipped. Daemon TypeScript passes.

An additional installed Herdr 0.9.5 pipe/CLI test completed its operational
assertions and server-exit checks but failed Node synchronous temporary-root
cleanup with EPERM; its overall result remains failed. A subsequent process
query found no Herdr processes, the exact residual tree contained no reparse
points, and native PowerShell removed that owned tree successfully. The cleanup
cause remains unproven. Source hashes and the failed result are retained in
the local herdr-cli-job-followup receipt. This does not close real Herdr overall
acceptance or its existing nested-console limitation.

### Rex Windows environment-key semantics (2026-11-02)

Rex executable and server selection now use the shared platform environment
reader. Native `Path`, `rex_bin_dir` and `rex_server` spellings behave like their
uppercase counterparts; POSIX keys remain case-sensitive. A native fixture
checks real executable discovery and the selected server's exact CLI argv.
The two transport/process files pass 28 tests on Windows (four POSIX cases
skipped) and 26 in the ordinary WSL source mirror (six Windows cases skipped).
Daemon TypeScript checking passes. This is configuration/transport coverage,
not installed Rex GUI acceptance.

### Rex no-launch and incomplete-reply semantics (2026-11-02)

A positively missing absolute Rex executable is now rejected before starting
the Windows Job helper, preserving ENOENT and the transport's unavailable
classification. This check does not claim to eliminate a later executable
replacement/removal race. Output exceeding the bounded stdout/stderr limit now
ends the owned command and reports an unknown request outcome rather than
silently accepting a truncated reply. Neither path repeats the request.

Both transport/process files pass 27 tests on Windows (four POSIX-shell cases
skipped) and 26 on the ordinary WSL mirror (five Windows process cases skipped).
The overflow tests execute real Node processes on both platforms and check the
unknown classification for each stream. Native missing-binary coverage checks
both the process error and the transport classification. Daemon TypeScript
checking passes. No installed Rex GUI or remote provider is involved.

### Rex native launch and control-process custody (2026-11-02)

Rex grids now carry exact generated Windows local/SSH tile argv directly rather
than putting it through local `sh -c`. Blank cells in a native grid use the same
PowerShell executable. POSIX pane commands retain their existing shell path.
The native grid fixture checks all three local tiles and the blank fourth cell;
the owned SSH fixture executes Rex's emitted argv with exact data and exit 7.

Rex control commands now use the existing atomic Windows Job launcher, retaining
strict descendant cleanup after timeout and normal exit. Native tests confirm
literal argv (including empty words), stdin, and acknowledged detached-child
cleanup at timeout and root exit 0/7. Native discovery checks `rex.exe` under
REX_BIN_DIR and semicolon-separated absolute PATH entries, avoiding the POSIX
resolver's drive-colon split and the macOS app fallback.

Four Rex/tile files pass 62 tests on Windows with four real POSIX shell cases
skipped; those exact changed sources pass 59 tests in the ordinary WSL mirror,
with seven Windows cases skipped. The separate daemon Rex-wiring case passed
in the preceding combined run. Daemon TypeScript checking passes. These are
process/transport/layout fixtures, not qualification of an installed Windows
Rex GUI or actual provider-backed remote attachment.

### Native Herdr SSH tile launch (2026-11-02)

Windows-composed SSH tiles now include an exact native PowerShell argv wrapper.
Herdr uses that wrapper instead of requiring local `sh -c`; the remote POSIX
command remains one unchanged SSH argument. Local tmux server arguments never
cross into the remote command. Generated-wrapper admission checks the complete
script and argv, so a modified script cannot enter this native rendering path.
SSH tiles retain their existing no-resume-command contract.

The three tile/resume/path files pass 44 tests on Windows, with the real POSIX
shell case skipped. A real owned Windows SSH-executable fixture, invoked through
Herdr's generated pane command, receives exact quoted/Unicode/backslash argv
and returns exit 7. The exact changed sources in the ordinary WSL mirror pass
42 tests, including that POSIX shell case; three Windows process cases are
skipped there. Daemon TypeScript checking passes. This verifies launch behavior,
not a real remote connection or Herdr's unresolved nested-console acceptance.

### Native local-copy directory permission finalization (2026-11-02)

The local-copy implementation now previews and repairs POSIX directory-mode
drift, creates new POSIX directories owner-accessible while copying children,
and applies the source mode after recursion so umask does not alter the final
permissions. Windows directory readonly remains excluded because it does not
represent directory access permission. An ordinary WSL UID-1000 test using the
exact changed source passes metadata-only repair, dry-run nonmutation, and a
new readonly directory containing a file under umask 0077. This is a scoped
source test in the retained WSL mirror, not a same-head full-platform run.
Windows local-copy and identity checks pass 20 tests; the POSIX mode test is
explicitly skipped there. CLI TypeScript checking passes. This does not close
NTFS/POSIX ownership, execute permission, ACL or special-file equivalence.

### Bounded-probe descendant lifetime follow-up (2026-11-02)

The native probe now preserves descendants only after its root exits and both
output streams reach EOF. Its helper owns separate output pipes and releases
kill-on-close only after positively observing that condition. Timeout, excess
output and descendants retaining output remain subject to Job cleanup. Installer
and finite model-CLI calls retain their stricter default descendant cleanup.

Real Windows detached-child fixtures cover root exit 0 and 7: a ready child with
closed stdio survives, while a detached child retaining output is terminated.
The six probe/Job/installer/Codex/Claude files pass 28 tests; two POSIX-specific
signal mechanics cases remain skipped on Windows. Daemon TypeScript checking
passes. This supersedes the background-lifetime gap immediately below, within
this fixture scope; it does not establish real-provider continuity.

### Installer exit coverage and remaining probe background lifetime gap (2026-11-02)

Native installer execution now has real exit-0 and exit-7 descendant coverage.
Each owned detached child acknowledges startup before its parent exits; both
processes must be gone before the installer result settles. Successful output
and nonzero stderr/code are retained. The installer/planner/executor/native-probe
files pass 38 tests, including timeout, output overflow and unrelated-child
survival checks. These use owned Node fixtures, not a real package installation.

The broader bounded-probe file previously used POSIX-only executable fixtures,
`printf`, `exec` and `ps`. Its Windows fake now has a literal Node `.cmd` launcher,
native PID reaping and quoted command paths; verifier PATH contains only its
fixture directory so a broken fake cannot fall through to an installed model
CLI. Before this correction a version assertion read the host's real Codex
version instead of the fixture. The POSIX group-stop fallback simulation and
POSIX TERM-handler final-output case are now explicitly POSIX-only; native Job
timeout/output behavior has separate actual coverage.

The corrected bounded-probe file passes 11 cases, skips those two POSIX-specific
cases and still fails one genuine behavior comparison: a successful POSIX probe
leaves a descendant that closed its standard streams running, while the current
Windows kill-on-close Job ends it. That expectation remains failing. Matching
normal-exit probe lifetime without weakening timeout/pipe-holder cleanup or the
installer's stricter whole-tree policy is open implementation work. Seven
explicit host-execution source files received bounded semantic review; this does
not clear the wider source inventory or full native suite.

### OpenShell private policy and binary result files (2026-11-02)

The OpenShell driver no longer relies on POSIX `0600` mode bits to protect
Windows policy staging or downloaded artifacts. Policy staging uses a verified
current-SID-only directory, and both policy bytes and downloads are written
through an exclusive private output handle whose DACL is established before
content. Existing destinations remain untouched on `EEXIST`; binary payloads
are never decoded/reencoded as text. The staging directory is removed after its
command completes, while the selected source policy remains unchanged.

The driver and observer files pass 14 tests on Windows, including real file
owner/private-DACL checks during policy dispatch and after binary download.
Daemon TypeScript checking passes. The same five-file driver dependency closure
is recorded by SHA-256 and transpiled into an isolated probe artifact; ordinary
WSL UID 1000 with Node 24.11.0 confirms private POSIX modes, exact policy/binary
bytes, exclusive destination refusal and stage removal.

These cases inject the OpenShell command responses while exercising actual
local filesystem effects. They do not qualify a real OpenShell/Podman engine.
The driver and rootless observer received explicit semantic review; that bounded
review does not establish completion of the wider source inventory.

### Real native exchange interruption recovery (2026-11-02)

Three additional complete-service cases inject an unknown client result after
the first, second or third real stock psmux rename has already been applied. The
service returns recovery-pending and leaves both controlled receiver processes
alive. A newly constructed adapter, lifecycle guard and switch service then read
the existing SQLite switch record without the original adapter's staging custody.

Each case reverses exactly the number of applied renames: it does not replay the
unknown-result forward operation. The predecessor process, canonical pane binding,
occupant generation and queue claim are retained. The uncommitted successor is
terminated, and the observed namespace contains only the canonical session after
recovery. All three cases pass in an 86-second run; 86 unrelated cases in that
file were unselected. Daemon TypeScript checking passes.

This verifies real terminal operations and fresh service/adapter recovery with
injected unknown outcomes. The database remains available to the new instances;
this is not an actual daemon/OS crash, disk-loss or power-failure experiment and
does not establish provider conversation continuity.

### Complete service on real native terminals with controlled receivers (2026-11-02)

Two new opt-in cases exercise the complete runtime-switch service with stock
psmux, real PowerShell/Node processes, a real lifecycle delivery guard, SQLite
repositories and a real queue claim. A controlled input receiver stands in for
each model harness; no model/provider request is made. Its actual received input
must contain the handover before the reserved successor generation confirms.
The predecessor is still alive and bound at that confirmation boundary.

On successful commit, the actual successor generation takes the binding and
queue claim, receives the activation text, and keeps running after the predecessor
process exits. On injected database commit failure, real native session names
roll back, the original binding/generation/claim and predecessor process survive,
and the uncommitted successor exits without receiving activation. No parking or
staging session remains in either completed case.

Both real-terminal service cases pass with the guard enabled. Their initial
fixture failures were corrected by applying the real outbox/guard migrations,
launching through `tmuxSession` as the production runtime adapters do, and
allowing only host-native taskkill commands after checking the PID's owned home.
The shared owned-terminal fixture was extracted so these tests and the terminal
tests use the same isolated home, registry, namespace and explicit executable.
All seven opt-in native terminal cases then pass. Six complete non-opt-in
service/custody/route/adapter/planner/journal files pass 292 tests, with the two
real-terminal service cases separately selected and passed; daemon TypeScript
checking passes.

This is real terminal/service/guard acceptance with controlled harnesses. It does
not establish actual Claude/Codex model behavior, real provider conversation
continuity or the deferred remote Pi OAuth acceptance. Same-head full platform
validation also remains required.

### Real native attached-client following and retirement (2026-11-02)

The owned stock psmux exchange test now covers zero, one and two real attached
clients. Each attached client gets its own hidden Windows console through a
task-owned launcher, not the test runner's redirected pipes or an existing user
terminal. Before exchange its presence is confirmed by the server. The actual
adapter client-following path then reconnects it to the successor's canonical
session, retaining the same client PID.

After following, removing the predecessor session leaves both the successor
pane PID and every attached client PID connected to the canonical session.
Final fixture shutdown confirms all hidden client processes exited before its
directory is removed. The zero-client case still checks reverse exchange and
restoration of both original pane identities and PIDs. All three native cases
pass; four unrelated cases in that file were not selected.

This qualifies the real attachment/following/retirement protocol path for the
tested stock psmux host. It does not replace provider-backed runtime-switch
acceptance, visible viewer rendering checks or the same-head full platform suite.
The prior missing real attached-client following evidence is superseded only for
these tested counts and lifecycle operations.

### Native runtime-switch service integration (2026-11-02)

The runtime-switch service now selects the native name-exchange coordinator on
Windows/psmux instead of passing scoped IDs to POSIX `swap-pane`. A partial or
unconfirmed exchange retains both servers and its durable recovery record; it
does not enter ordinary staging cleanup. After a completed exchange the canonical
pane is read again, and the remapped successor pane is persisted atomically with
the runtime commit. Database commit failure reverses the native exchange before
the uncommitted successor can be retired.

Native recovery uses recorded generations and observed slots, including the
parking session, rather than interpreting a renamed scope ID as physical pane
identity. It handles interruption at each rename, abandonment whose retirement
failed, a committed predecessor already terminated, and an already absent retired
server. Staging custody is adopted for the occupant appropriate to the direction
before termination or removal.

The adapter also has a source-server client-following path. It validates the
successor and predecessor, issues identity-checked client switches from the
predecessor's server, and waits for attached clients to leave before allowing
retirement. Malformed, incomplete or changed client observations retain the
predecessor and record an attention message. Stock psmux's boolean
`session_attached` is treated as presence rather than tmux's numeric client count.

Six complete service/custody/route/adapter/planner/journal test files pass 292
tests, including native-path simulated-server exchange, canonical binding
remapping, three uncertain rename outcomes, commit rollback and deferred client
following recovery. These service cases use fake terminal processes. The actual
stock psmux exchange test separately passes node/generation checks, forward and
reverse PID continuity and the no-attached-client retirement prerequisite. Daemon
TypeScript checking passes. Real attached-client following and full native
provider-backed runtime switching still need acceptance. This supersedes the
earlier missing service-wiring limitation, not the remaining acceptance matrix.

### Native adapter exchange backend qualified (2026-11-02)

`TmuxAdapter.nativeRuntimeExchangeTerminal` now supplies the coordinator's native
backend. Its observations require a positively present session, one window, one
pane, the expected node identity and an explicit nondead pane. It reads occupant
generation independently of the mutable scoped pane ID. Transport failures or
foreign node identities remain unknown, not absent.

Each rename checks lifecycle custody, allowed source/destination slots and a
positively absent destination. The psmux server itself checks node and generation
inside `if-shell` before executing the rename. Afterward both source absence and
the destination's occupant are observed; an unproved outcome returns pending
rather than silently retrying.

The actual adapter path passes an owned stock psmux forward/reverse exchange,
retaining both original PIDs. Occupied destinations, wrong node identity and
wrong generation are refused without moving the occupants. The existing adapter
and complete planner/journal files pass 185 tests; daemon TypeScript checking
passes. Four unrelated native cases were not selected in the native run.

Runtime-switch service orchestration is still not connected to this backend.
Commit/recovery binding remapping, attached-client following and retirement
remain open; the backend result does not qualify complete Windows `set-runtime`.

### Native exchange custody journal and uncertain-result recovery (2026-11-02)

The native exchange coordinator now persists its schema, three session names,
both occupant generations and intended direction in the existing switch row's
plan JSON before any rename. Existing plan fields are retained. Custody must
match the switch's node, canonical/staging names, generations and commit state;
rollback after commit is refused. A new coordinator reads the persisted record
after its SQLite connection closes and reopens.

Fault tests model each of the three renames being applied by the server while
the client reports an unknown result. The invocation stops; recovery reobserves
the slots and finishes without replaying the applied rename. Lease loss before
work or during observation prevents the next rename. Foreign custody and
malformed identities are refused. The two complete planner/journal files pass
25 tests; daemon TypeScript checking passes.

The owned stock psmux exchange test also verifies server-side conditional rename:
a wrong occupant generation selects the refusal branch and leaves the source
unchanged; the correct generations complete both forward and reverse exchanges
without changing either PID. This native case passes, with four unrelated native
tests unselected. The coordinator requires its eventual backend rename operation
to perform that identity check at the write boundary.

These components still require runtime-switch service and native adapter wiring,
binding remapping, attached-client following and retirement acceptance. They do
not make `set-runtime` complete on Windows yet.

### Native exchange primitive and observed rollback (2026-11-02)

A generation-based native exchange planner now maps fresh observations of the
canonical, staging and parking session slots to exactly one rename. The three
forward states and their reverse states retain both server processes; missing,
unknown, foreign or duplicate occupant identities refuse another write. A client
timeout is not interpreted as a failed rename: the planner's contract requires
fresh observations before any next operation.

An owned stock psmux 3.4.0 test performs the real three-rename exchange and reverse
sequence, checking generation environment values and both original pane PIDs.
Both processes survive and return to their initial addresses on rollback.
Scoped pane IDs change when their session name changes, confirming that recovery
must use generation identity rather than relying on a stable scoped ID. The
planner's 17 cases plus the native exchange pass; four unrelated native tests
were not selected. Daemon TypeScript checking passes.

This primitive is not yet wired into the runtime-switch service. Durable custody
before the first rename, interrupted-exchange recovery, binding remapping,
attached-client following and predecessor retirement still require integration
and acceptance. The runtime-switch implementation gap below remains open.

### Native runtime-switch and literal-name gaps identified (2026-11-02)

The pane identity audit finds a current implementation gap in runtime switching:
`swapRuntimeSwitchPanes` requires bare `%N` identifiers, so valid scoped native
`psmux:<session-base64url>:%N` identities return `runtime_switch_target_changed`
with "Exact pane ids are required." A bounded direct invocation reproduces the
refusal with zero terminal executor calls. The real seat runtime-switch service
uses this method for exchange and rollback, so scoped pane discovery alone does
not establish Windows runtime-switch equivalence.

Simply accepting the scoped identifier would be insufficient. Stock psmux 3.4.0
does not support cross-session `swap-pane`; its cross-session `join-pane` uses a
TCP proxy with the real ConPTY retained in the source process. A native exchange
must therefore handle source-server lifetime, rollback, staging retirement and
durable recovery without killing the successor's real process. This remains
implementation work; no runtime-switch acceptance is claimed.

An owned stock psmux test with a literal `|` in the session name also fails at
the client's ten-second creation deadline, before pane parsing is reached.
The checked v3.4.0 path code uses literal session names for registry filenames.
The fixture cleanup completes and an exact-namespace process query finds no
remaining psmux process. Linux literal-name coverage does not qualify this native
case; native naming equivalence remains open. No live team or main daemon was
changed by either investigation.

### CRLF ordinary terminal-list equivalence (2026-11-02)

The shared list parser now recognizes CRLF as well as LF, extending the batch
reader correction to session, window, pane and attached-client lists. The
regression fixture first reproduced an attached session being reported as
detached under CRLF. Corrected parsing also retains active window/pane flags and
the exact client session identity, including separator characters and meaningful
spaces in names and paths.

The complete adapter, batch-read, exact-target and argv-exec files pass 227 tests;
daemon TypeScript checking passes. This is evidence for both line-ending forms
at the adapter boundary, not a claim about which particular native executable
emits CRLF or completion of real interactive viewer acceptance.

### CRLF activity-batch equivalence (2026-11-02)

Both batch window readers now split LF and CRLF transport records without
retaining a carriage return in the session key. Before the fix, the CRLF fixture
made the activity sweep lose every valid seat observation, while per-seat reads
still reported the active/idle state correctly. The repaired sweep equals the
per-seat result for both line endings, retaining the one-call batch behavior.
Session names containing the field separator and meaningful trailing spaces
remain unchanged; this does not use a blanket trim on identity fields.

The complete batch-read and batch-capture files pass 37 tests, and daemon
TypeScript checking passes. This proves the transport parsing and activity
service behavior under the tested records, not that a particular stock psmux
release emits CRLF or that the remaining interactive backend requirements pass.

### Qualified SFTP upload link timestamps (2026-11-02)

The SFTP client now records extension versions and uses version 1 of
[`lsetstat@openssh.com`](https://github.com/openssh/openssh-portable/blob/master/PROTOCOL)
for timestamp-only no-follow attributes. A per-directory, per-transport probe
first creates an exclusive referent and relative symlink, applies distinct
timestamps, checks both objects and removes the probe entries. Only a passing
probe allows timestamp operations on the copy's staged or existing link. An
unknown extension version never sends the request; ordinary SETSTAT is never a
fallback for symlinks.

Real Windows OpenSSH advertises this extension but follows the link: its link
timestamp stays unchanged while its referent changes. The exclusive probe
detects this without changing the copy's real referent. This server also refuses
creation of a dangling link. The transfer reports failure and retains its
staging hint rather than claiming archive-equivalent success. Windows remote
link timestamp uploads therefore remain incomplete; an advertised capability is
not qualification.

The same Windows client successfully uploads and repairs link timestamps against
the real Ubuntu 24.04 OpenSSH 9.6p1-3ubuntu13.20 subsystem running as an ordinary
user. Dry-run leaves the link unchanged, metadata repair transfers no file bytes,
the referent timestamp stays unchanged and no probe entries remain. The server
package is extracted in a task-owned directory; no SSH service is installed or
started. Four native copy/protocol files pass 37 tests and the CLI build passes.
This supersedes the prior client-side missing-extension limitation for qualified
servers only, not the full archive or cross-host acceptance requirements.

### Native symlink timestamp preservation (2026-11-02)

Native local copies now preserve the link's own timestamps using `lutimes`,
including directory links, and repair mtime drift on an otherwise unchanged link
without replacing its inode. Native SFTP downloads apply the same operation to
the staged link before rename and to existing matching links. Dry runs report
the timestamp change without writing. Neither operation follows the link to
change the referent's timestamps or permissions.

The three native copy test files pass 31 tests and CLI TypeScript checking
passes. An ordinary WSL-user `rsync -a` comparison confirms new-link timestamp
preservation, unchanged-link metadata repair with inode retention, dry-run
nonmutation and unchanged referent timestamps. These are scoped comparisons,
not a full current-head suite result. Uploading link timestamps remains open:
the current SFTP v3 client has no qualified no-follow timestamp extension, and
ordinary SETSTAT must not be used because it can modify the referent.

### Installed native file effects verified (2026-11-02)

The target-native package Gate passes at `e76b08e2967a5161ac72e135bfb66e015b99664f`
with unchanged tracked-source hashes before and after its 67-second run. Besides
building, packing and installing into an isolated prefix, the Gate executes the
installed native helpers to compare Unicode filenames, query directory case
sensitivity and replace a readonly destination while retaining the previous
hardlink's bytes and readonly attribute. A repeated unchanged copy preserves the
destination inode and leaves no staging entry. Installed resource operations,
SQLite loading and the `rig.cmd` daemon-subpath check also pass.

The first new fixture incorrectly used equal-size files created within one
second, so archive quick checking legitimately skipped their content difference.
The corrected fixture uses different sizes to force replacement. This was a
fixture correction, not a change to copy comparison semantics. This installed
scope does not clear the full-suite crash, terminal attachment or remaining
archive metadata requirements. Remote real Pi OAuth continuity remains deferred
at the user's request; no authentication retry is part of this result.

### Equal regular-file inode copies match rsync (2026-11-02)

The identity overlap guard now applies to directory recursion only. A real WSL
`rsync -a` probe confirms that a regular file copied to another hardlink of the
same inode succeeds without replacing it. Native local copy now does the same
for identical-file and hardlink operands; the ordinary equality fast path writes
nothing and preserves both inode identities. This corrects an overly broad
rejection introduced by the prior filesystem-identity change. The local/SFTP/
identity run passes 28 tests and CLI TypeScript checking passes; directory and
junction recursive-overlap refusals remain covered.

The exact-worker ProcDump run finishes the frozen nine-file diagnostic without
an unhandled exception, generating no dump; temporary dependency changes restore
to their original hash. No machine-wide crash handler is installed and the live
daemon is untouched. The earlier 0xC0000005 remains unresolved; a debugger-assisted
passing run is not proof that the native crash is fixed.

### Native Unicode filename collision comparison (2026-11-02)

Local and SFTP collision checks now use Windows CompareStringOrdinal for names
containing non-ASCII characters, with a direct ASCII fast path. JavaScript lower-
casing incorrectly conflated K and the Kelvin sign on this host's NTFS volume;
both are legitimate distinct entries here. Real native and OpenSSH subsystem
fixtures now copy their different bytes successfully, while ASCII case collisions
remain refused in ordinary destinations. The three copy/identity files pass 26
tests; daemon build and CLI TypeScript checking pass. This establishes the tested
host behavior, not every historical volume's Unicode upcase table.

The controlled SQLite diagnostic at frozen 5659e82 replaces only the test
directory's better-sqlite3 entry with task-local 12.11.1. The same nine-file set
completes 1,670 tests with six pending, and both altered dependency entries are
restored by SHA256. Native Rollup versus same-version WASM still crashes with
0xC0000005, so native Rollup alone is not sufficient to explain the failure.
The original-13.0.3 reverse control also completes 1,670 tests/six pending and
restores the observer hash. The crash is therefore intermittent under this
comparison; neither a deterministic version regression nor a downgrade fix is
established. No production dependency or live daemon is changed. Further
diagnosis will capture the exact owned worker's native exception rather than
repeat whole-suite version/worker parameter changes.

### Local directory case-collision refusal (2026-11-02)

Native local directory copies now perform the same destination-capability check
as SFTP before copying a directory's case-colliding child entries. A default
case-insensitive NTFS directory refuses the operation instead of overwriting or
silently skipping the second file; an enabled directory retains both names and
their different bytes. Real preview and copy fixtures prove the refused target
stays empty and preview never writes file data. The local identity/local copy/
SFTP run passed 24 tests; CLI TypeScript checking passed. This directory-level
check is not a whole-tree transaction or qualification of every filesystem's
Unicode case table.

### SFTP case-distinct names on qualified NTFS directories (2026-11-02)

SFTP now queries the actual destination directory's FileCaseSensitiveInfo through
a no-final-reparse native handle before accepting names that differ only in case.
A new dry-run directory checks the closest existing parent; actual copying checks
the created destination. Ordinary case-insensitive destinations still refuse the
collision before writing files. Unknown/unsupported case-query capability does
not permit collision-prone writes. On this host, real OpenSSH SFTP fixtures prove
distinct Name.txt/name.txt bytes survive in an enabled directory and an inherited
new subdirectory, while an ordinary destination stays empty on refusal. Nine SFTP
tests plus the native local identity fixture pass; daemon build/CLI typecheck
pass. This does not make reserved Win32 names representable.

The nine-file native-crash prefix bisects into passing groups: the first five
files pass 1,070/five pending; the remaining four also complete without an
unexpected worker exit. Both observers restore the original dependency hash.
The combined nine-file access violation therefore remains a composition or
intermittent condition; neither passing half establishes a root cause or a
passing full native suite.

### Option-shaped native environment names (2026-11-02)

The native private config and session read/unset commands now insert psmux's
explicit `--` operand boundary for variable names beginning with a dash. Real
stock psmux proves an `-owned` name survives initial launch, adapter and external
respawn, current-value updates, readback and unset without being interpreted as
an option. Private DACL, scoped-launch/recovery and staging regression runs pass
21 tests with one platform skip; daemon TypeScript checking passes. Control-
character names remain unrepresentable by the config-line protocol and are not
claimed as implemented.

Native-crash narrowing adds two negative reproductions at 5659e82: the last
worker's queue-stuck file passes 134/134 independently, and a non-Vitest process
performs 500 in-memory real migrations/query/iteration/close cycles with explicit
GC successfully. These results do not establish a faulty native module or close
the access-violation investigation; the nine-file unrequested-exit evidence still
stands.

### Case-sensitive native copy identity and worker exit evidence (2026-11-02)

Local overlap detection now compares bigint filesystem device/file identities
along the physical destination's ancestor chain, rather than case folding names
or using Windows's case-insensitive lexical relative-path rules. Existing
junction parents are resolved even for a new destination. A source with no file
identity is refused instead of silently bypassing overlap checks. On this host,
fsutil successfully enabled case sensitivity on an owned temporary NTFS test
directory: distinct Source/source directories and File.txt/file.txt entries copy
correctly. Fourteen native identity/local-copy tests pass; the same case-sensitive
identity fixture passes under WSL uid 1000. CLI TypeScript checking passed. This
qualifies these owned filesystem operations, not every runtime's path behavior.

Reduced native crash diagnosis: the last three files pass 363 tests/one pending;
adding CLI queue passes 529/one pending. Replaying the common nine-file prefix
with exit-only test-pool instrumentation captures worker PID 60364 exiting
3221225477 (0xC0000005), with terminating=false, immediately before the secondary
IPC-channel error. This proves an unrequested access-violation exit, not which
native module caused it. The temporary dependency observer was restored to its
original SHA256 afterward. Root cause and complete native suite validation remain
open; the smaller passing combinations do not close them.

### Native local-link type preservation and repair (2026-11-02)

Local copies now compare the NTFS link-entry directory attribute as well as link
text. Equal-text but mistyped links are repaired through an exclusive sibling
symlink and rename; referents are not copied or traversed. Unlike SFTP v3, the
native source entry supplies directory intent even for a dangling link, so local
copies preserve that type. Ordinary destination directories remain refused when
copying a file/link over them. Real existing and dangling directory-link fixtures
verify preview without mutation, repaired type, retained referent bytes, zero
content transfer, clean repeated preview and no successful staging leftovers.
The local/SFTP copy run passed 21 tests; CLI TypeScript checking passed.

### Repair previously mistyped NTFS links (2026-11-02)

SFTP no longer skips an equal-text destination link when a known directory
referent requires a directory-typed NTFS link. A native attribute probe inspects
the link entry without traversing it; ordinary rename replaces the staged link
while leaving its referent untouched. Preview reports the repair without changing
the old entry. Repeated preview is clean after repair. Unknown dangling referent
type retains an existing equal-text link rather than guessing its type. Eight
real native SFTP copy tests pass, including broken legacy file-typed links,
successful directory access, zero referent bytes copied and dangling inode
retention. The protocol/local-copy regressions and daemon build/CLI typecheck
also passed. New dangling links still cannot infer directory intent from SFTP v3.

### Full native runner failure boundary at 5659e82 (2026-11-02)

An isolated detached worktree installed dependencies and built all workspaces.
The protected untracked diagnostic was absent and explicitly excluded from
selection. A two-worker Node 24 run failed with a native N-API/V8 assertion before
producing a report. A single-worker verbose run retained at least 1,732 passing
events before worker IPC closed; the last printed pod-instantiator file passes
75/75 independently. Node 22.14.0, downloaded into the task directory and checked
against the official SHA256 manifest, also passes that file 75/75 but the complete
single-worker comparison again exits with a closed IPC channel. All three
attempts retained the exact HEAD and empty tracked diff, and none produced a
complete JSON report. No matching Windows application-crash event was found in
the inspected time window. Node 24 alone is therefore not an established cause.
Stop further whole-suite parameter retries: the doubtful assumption is that a
runtime-version/worker-count change can resolve this without a smaller reproducer.
These incomplete attempts do not count as full validation or close implementation
requirements; isolated diagnosis and other repair work remain open.

### Native instance-home identity in durable server records (2026-11-02)

Windows server selection now uses native realpath spelling, including the
existing parent of a not-yet-created home. Its socket identity therefore does
not change merely because mkdir made a DOS/long-name parent resolvable. Reading
older records resolves their home spelling too; offline attachment uses the same
native identity check. Drive-case aliases no longer reject a valid pin or select
a different namespace. This uses filesystem resolution, not blanket case folding;
invalid or genuinely different homes remain refused. The four server-selection/
attachment files passed 92 tests with two platform skips, including a real
drive-case/legacy-record fixture; daemon TypeScript checking passed.

The safe static candidate inventory was refreshed at 5659e82: 1,638 production
text files, 544 candidates, 134 unchanged/76 changed/334 outside the older
ledger. One private row was excluded before reads. Two additional explicit
source reviews (log-tail and preflight-exec) found no new implementation gap in
those files; this does not close the unreviewed inventory.

### Real tmux normalized-name recovery and hermetic ref failure (2026-11-02)

tmux 3.4's printed name for a literal dollar can contain escaping that is not a
usable exact session target. Chatroom watcher creation now requests the stable
server-local session ID and quotes it in the attach guidance, retaining the
original rig label and watcher argv. Real tmux tests verify the ID addresses the
created session and the watcher receives the unchanged rig name; stock psmux
also proves ID lookup, original argv and namespace-bound whoami routing. This
fix does not claim server IDs remain stable across server restarts.

The release-surface missing-ref test now initializes its own temporary Git
repository, so an archive checkout tests the intended missing-ref error rather
than accidentally testing absence of a surrounding .git. It checks that the
error names the requested ref and retains the fact/consequence/action fields.

The five files containing all eight failures from the a03de2d ordinary-user WSL
run now pass 64 tests with five platform/tag skips after these and the terminal
follow-ups. Windows chatroom tests pass 69 with 17 real-tmux skips, including
real stock psmux; release-surface passes ten separately. These targeted receipts
do not replace the still-required full run at a common final head.

### Windows nonidentifier environment persistence (2026-11-02)

The private session transport now accepts and quotes representable native names
outside shell-identifier grammar instead of silently excluding them from scoped
launch persistence. Its read/set/unset validation uses the same name boundary.
Real stock psmux tests prove names containing spaces, dots, hyphens, Unicode,
quotes and literal `#{pid}` survive initial launch, adapter respawn and raw
external respawn. Session updates are read back and later respawn observes their
new values. Values remain off launch argv. Twelve native private-environment/
DACL/injection-boundary tests and daemon TypeScript checking passed. Names
starting with a dash or containing control characters remain outside this
private config grammar; this is not arbitrary Windows-name qualification.

The correctly built WSL full CLI/TUI run under codexqa (uid 1000), still at
a03de2d, finished with stable source hashes: 7,377 passed, eight failed, 132
pending (7,517 counted). Six failures are the terminal/discovery issues repaired
in the follow-ups above/below; real tmux special-name and release-surface failure
classification still require diagnosis. This is not a passing full-suite result.

### Terminal composition across host platforms (2026-11-02)

TerminalService now validates a resolved executable with the selected local
platform's absolute-path rules. A win32 composition evaluated on Linux no longer
silently discards an absolute C:\\... psmux path. Local and SSH recovery commands
also carry an explicit powershell/sh discriminator on both platforms. The real
HTTP preview/composition, native discovery and TUI terminal journey files passed
30 tests on Windows and 29 on WSL (one native Windows discovery skip), using the
same source follow-up over a03de2d. Daemon TypeScript checking passed. Desktop
launch and provider liveness in these tests are fixtures; no GUI qualification
is inferred.

### Full CLI/TUI and permission comparison at a03de2d (2026-11-02)

The complete Windows CLI/TUI directory run (no file exclusions) finished in
572 seconds: 7,421 passed, two failed, 95 pending, 7,518 counted. HEAD and empty
tracked diff were identical before/after. One failure was the ACP companion
fixture's final directory removal (EPERM), after its exit checks; this remains
unresolved, not a provider failure or a successful teardown. Its repeated cleanup
workaround budget is exhausted: the doubtful assumption is that observing the
companion PID exit proves every directory-holding descendant/console handle has
been released. No further blind cleanup retries are counted as validation.

The other failure was an obsolete two-argument discovery spy assertion: the
shared native-tool executor now passes an explicit optional deadline argument.
The test now checks the same selected absolute where.exe and wt.exe operand with
that undefined deadline. All 19 native discovery/preview tests passed afterward.

The initial WSL root run retained stable source hashes but was prepared with only
the daemon build: missing CLI dist caused multiple failures. Its 7,273 passes,
55 failures and 189 pending are retained as diagnostic evidence, not accepted
full comparison. A fresh ordinary-user (codexqa, uid 1000) snapshot with daemon,
CLI and TUI builds is running the full directories separately.

Six permission-focused files at the same commit produced 25 passed/three pending
under uid 1000, versus 23 passed/five failures on Windows. The five failures assert
POSIX 0755/0644 values on NTFS; they do not alone establish whether a helper can
run. The existing native hook projection uses explicit Node invocation; its 14
real manifest/refresh tests passed, including all shipped hook events, Unicode
stdin and exit codes. General executable-bit/archive semantics remain open.

### Local readonly replacement (2026-11-02)

Changed regular local files now copy into an exclusive sibling staging entry
before Windows native replacement. The same native operation used by SFTP keeps
the destination DACL, applies the source readonly state, and restores the old
inode's readonly state for retained hardlinks. Failed replacement reports the
staging path rather than deleting the old destination. Real NTFS tests cover
writable and readonly sources replacing a readonly destination, original alias
content/attributes, nonmutating preview and no staging leftovers after success.
The local/SFTP/transfer run passed 60 tests with three existing platform skips;
CLI TypeScript checking passed. This does not qualify POSIX ownership or ACL
translation, concurrent hostile mutation, or crash/power-loss recovery.

### Local copy metadata drift (2026-11-02)

Native local copies now report and repair representable file-mode drift even
when size and second-resolution mtime match. On Windows this compares the owner
write/read-only bit, not unsupported POSIX permission semantics. Dry-run reports
the permission change without mutation; repair transfers zero content bytes.
Directory mtime differences now appear in dry-run and remain restored after
children are copied. Nine real native local-copy tests and 43 transfer tests
passed (three existing platform skips); CLI TypeScript checking passed.

### SFTP directory symlink type (2026-11-02)

Downloads to NTFS now query the source link's referent type with SFTP STAT and
create a directory symlink when that referent is a directory. The original link
text is preserved; the referent is not recursively copied. A real Windows
OpenSSH subsystem round trip verified that the downloaded entry remains a link,
retains its relative target, allows directory traversal, and transfers zero file
bytes. The nine native subsystem/protocol tests and 55 transfer/path tests passed
(three existing platform skips); CLI TypeScript checking passed.

A dangling POSIX link carries no directory/file type in SFTP v3, so its future
directory intent remains unknown and is not covered by this result. Ownership,
execute bits, directory ACLs and special files remain open below.

### Native Bash idle and receiver distinction (2026-11-02)

The canonical scoped bootstrap now exposes only its unique, creation-time-bound
shell child to idle-shell verification. Bare native Bash/sh/dash/zsh/ksh argv
are accepted only with the bounded interactive/login flags; command/script argv,
ambiguous children and extra console receivers remain refused. Known shell leaves
(including fish/nu/csh/tcsh) no longer count as community provider receivers;
this classification alone does not qualify their command-delivery behavior.

Real stock psmux with Git Bash now proves idle=true/receiver=false before launch
and idle=false/receiver=true after its owned Node runner starts, alongside exact
managed-runner attribution and wrong-launch refusal. Eight real Bash/cmd/
PowerShell tests passed; 275 lineage, scoped-parent and receiver cases passed,
and daemon TypeScript checking passed. These scoped receipts do not close the
remaining platform requirements below.

These remain required by the parity goal. Later scoped passes do not close an
entire row. This is a current work list, not proof that discovery is exhaustive.

| Requirement group | Current missing or unverified scope | Evidence needed to close |
| --- | --- | --- |
| Terminal and engine behavior | Real Herdr/stock psmux in-pane attachment remains failed/unconfirmed; Git Bash managed command delivery has a scoped real pass, while other shell/legacy-pane combinations remain unqualified; Rex native launch/control mapping now has scoped fixtures but real GUI acceptance remains unqualified; real rootless Podman/OpenShell is unverified, with the native MXC/Linux guest-contract distinction above. | Actual identity-bound attach/input/follow/reuse/stop and engine lifecycle effects on owned native instances, preserving source sessions and drafts. |
| File and metadata behavior | POSIX owner/group/execute, directory ACL semantics and special-file equivalence remain incomplete. Readonly replacement and directory-time repair are scoped passes. | Explicit cross-platform metadata semantics plus bidirectional real transfer and failure/retention evidence; no unsupported field counted as preserved. |
| Discovery and same-head verification | The latest safe static inventory at 51708ce inspected 1,638 production text files and selected 544 candidates: 137 unchanged against its older ledger, 73 changed, 334 outside that ledger; one private row was excluded before reads. Those classifications are not semantic reviews. Current complete Windows/Linux suites have not passed at a common frozen head. | Reconcile changed/outside-ledger behavior, run applicable complete suites on the same source, and retain exact failures/skips/coverage limits. |
| Real harness and remote continuity | Remote Pi OAuth renewal is deferred by the operator; the owned SSH host is currently unreachable. The new Windows SSH front door, other harness lifecycles and current installed-runtime continuity remain unverified. | Owned real provider, SSH front-door, reconnect/restore and installed-runtime receipts after the external prerequisites return. |
| Host/platform qualification | Foreign-user daemon endpoint access, supported runtime/architecture and Job policy combinations, reboot/suspend/power-loss behavior remain unverified; latest source is not deployed to the main instance. | Isolated real acceptance with explicit host conditions; deployment and disruptive host actions must respect existing runtime ownership and user boundaries. |

The 72-second native build/pack/isolated-install gate at 686b954 is a passing
package receipt, not a full-platform or current-deployment result. New loader
attribution changes below have targeted validation and are newer than that gate.

Initial map at source commit `c778b2a52` (2026-10-30), with later scoped,
source-bound updates below. This is an implementation
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
| Initial-shell environment policy | Native private bootstrap for PowerShell/pwsh/cmd, selected environment and fresh pane identity; [native scoped launch](../../packages/daemon/test/windows-scoped-launch.test.ts). Stock 3.4.0 empty-server startup, first session, dead-pane respawn and interactive command pass with Windows PowerShell 5 and pwsh 7.6.9 in isolated namespaces. | Live provider/fleet acceptance and unsupported shell semantics. Stock psmux's separate `-e` argv visibility limitation remains. |
| Pi and OMP | Native executable/npm dispatch and argv-aware protocol fixtures; [native dispatch](../../packages/daemon/test/pi-omp-native-dispatch.test.ts). Earlier reconciliation covered 59 protocol/dispatch cases. | Actual provider conversations, compaction and complete restore. |
| Community harnesses | Metadata reaches the child; standard npm entries resolve against the seat cwd, including relative PATH and command paths; [native environment](../../packages/daemon/test/community-harness-native-environment.test.ts). Combined protocol/activity run passed 70 cases. | Arbitrary batch launchers are deliberately not translated; installed third-party providers and real restore remain unverified. |
| ACP | Native command selection and bounded owned process handling; [selection](../../packages/cli/test/acp-native-command-selection.test.ts), [process handling](../../packages/cli/test/windows-acp-process.test.ts). | Live agent/queue acceptance; previously unresolved companion cleanup behavior. |
| Transcript continuity | Short native staging names, cleanup after partial writes and boundary replay through stock psmux; [long names](../../packages/daemon/test/transcript-long-name-native.test.ts), [write failure](../../packages/daemon/test/transcript-write-failure-native.test.ts), [stock replay](../../packages/daemon/test/transcript-boundary-psmux-native.test.ts). | Live provider output and restart/restore across the complete installed runtime. |
| Compaction restore hooks | [Real hook round-trip](../../packages/daemon/test/stub-compaction.test.ts), [spawned compaction runner](../../packages/daemon/test/stub-runner-compaction-e2e.test.ts) and [spawned restore runner](../../packages/daemon/test/stub-runner-restore-e2e.test.ts) pass eight cases: shipped scripts act on owned synthetic transcripts, reject distinct identity, deliver once and record the injected clock. Native transcript-alias evidence remains separately recorded. | Actual provider compaction, full runner restart/restore and installed plugin acceptance. |
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
| Context stores | Overlapping roots retain physical-pack custody across native case aliases; [native custody cases](../../packages/daemon/test/context-pack-store-recursion.test.ts). Full recursion file: 24 passed, three symlink-creation failures (`EPERM`). Library/compose/remove files: 32 passed after separating the non-directory check, one symlink-creation failure. | Symlink-dependent context-store checks and installed delivery. A successful directory-junction case does not establish file-symlink support. |
| Spec library | Native rename supports long storage names, reserved device names and case-only changes; [service](../../packages/daemon/test/spec-library-service.test.ts), [routes](../../packages/daemon/test/spec-library-routes.test.ts). Full service/route files pass 22/22; four workflow scanner/route files pass 57/57, including native folder-alias reconciliation. | Every authored resource/install combination and installed delivery. |
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

### Current package gate and hook-observation boundary

The strengthened native tarball gate passes at exact 910f46b4d46387e1ecac3ed2f4511a6cec85b9e7 with unchanged tracked source (pack-gate-910f46b-current.json). It rebuilds and installs the actual package in an owned prefix, checks SQLite ABI, runs the installed rig.cmd daemon-loading command, compares the delivered native helper bytes and checks its real usage exit. No publication or runtime deployment occurs. Protected untracked diagnostics still preclude a clean-release metadata claim, and absent leak-guard term rules remain an explicit skipped check.

A separate bounded Claude SDK initialization with an owned SessionStart plugin did not produce a hook receipt within three seconds (claude-native-plugin-hook-910f46b-unobserved.json). The initialization returned the fixture skills, but no user turn was requested. This is unobserved dispatch, not evidence of a product failure or a passing hook invocation. The owned Job was stopped and its tree removed; no user/model message was sent. Actual provider hook dispatch therefore remains unverified despite the earlier positive renderer and shell-fixture results.

### Unstarted native scoped-bootstrap cleanup

The launch-boundary review found that a native scoped bootstrap was written before the terminal request, but its callers did not reclaim it after positive no-start evidence. Seven owned-file cases reproduced four failures before repair (scoped-cleanup-4a8fd74-before.json). The adapter now tracks only the successfully staged native bootstrap and releases it after a client spawn failure, or an explicit duplicate-session refusal during creation. Respawn handles the same spawn-failure boundary. Cleanup failure preserves the original request error.

Timeouts, unknown transport results and successful submissions retain the bootstrap for its consumer; environment-protocol files and unknown mutations retain their existing rules. No broad temp scan or default-server access is added. The new tests use real owned files with injected transport outcomes, including cleanup refusal. Together with native scoped-launch and create-readback files, 14 pass and two are skipped (scoped-cleanup-4a8fd74-native.json); argv/environment regressions pass 11 with five skipped (scoped-cleanup-4a8fd74-regression.json). Daemon TypeScript and documentation checks pass. The installed tarball gate above predates this cleanup change; no actual deployment was modified.
## Native service recovery gate and checkpoint metadata

A source-frozen run at `3ce8064200da10b33f9f7e8981da08f97131dd55` passes all
44 cases across native Compose, services snapshot/teardown, service startup,
replica readiness, checkpoint storage and checkpoint schema tests. HEAD and
tracked-diff hashes match before/after. These use owned SQLite, native argument
receivers and loopback HTTP/TCP; Docker and terminal effects are injected. In
particular, the existing snapshot/restore-named file checks receipts and teardown,
not a complete service restore by itself.

The added [native restore service gate](../../packages/daemon/test/windows-service-restore-gate.test.ts)
therefore invokes the actual RestoreOrchestrator with its ServiceOrchestrator
dependency and a native Node receiver standing in for Docker. Three cases prove
that `up` and successful status retrieval precede seat launch; failure of either
step refuses restore before any seat launch. The Windows compose-file path has
Unicode, spaces, ampersands, percent signs and an apostrophe; the receiver records
the unchanged argv. Success persists a fresh healthy receipt, failure leaves its
initial receipt absent, and both retain the historical snapshot bytes. Only a
synthetic terminal seat and mocked tmux effects are involved.

The new three-case gate plus the five native Compose cases pass 8/8. The first
draft of the fixture referred to the wrong launcher method (`startNode`); it was
corrected to the actual `launchNode` seam before the ordering assertions ran.
This repairs a coverage omission, not a discovered production service bug.
Actual Docker/container restoration remains unverified; no Docker daemon, deployed service or existing rig
was accessed or started.

Follow-up production-call-site searches across daemon, CLI and TUI find
`runCheckpointExport`/`runCheckpointImport` only at their adapter definitions.
There is no in-repository caller connecting them to snapshot/restore on any
platform. The adapter APIs' authored shell commands have not been executed here;
they are not a demonstrated Windows-specific regression or a completed service
checkpoint workflow. Adding a new cross-platform workflow is not inferred from
the native parity audit. This corrects the earlier broad checkpoint caveat above;
the 44-case checkpoint tests concern persisted metadata, not these unused methods.

## Paired seat CLI hook compatibility after shim changes

Review of the original 26 changed ledger entries found an integration regression:
the seat-bin generator had advanced through v3–v5 while the shipped
`rig-command.cjs` recognized only the older v2 direct-Node batch form. With an
actual generated v5 bin, the hook could not resolve this installation's paired
CLI. The expanded native fixture reports three failed / three passed before
repair: v3/v4/v5 fail while v2 and existing npm resolver cases still pass.

The hook now recognizes v2/v3 direct-Node shims and the complete finite v4/v5
PowerShell bridge forms. It verifies the generated script bytes, version-specific
directory digest, current Node interpreter and declared OpenRig package entry,
then invokes Node/CLI directly without executing either shim. Added commands,
modified sidecars, wrong interpreter/digest and changed package declarations
remain refused. The tests use real generated shims, Unicode/metacharacter paths,
literal empty/quoted arguments and child exit code 7. Existing tampering fixtures
were updated because their old percent/path replacements no longer changed the
new ASCII bridge.

Four hook/projection/vendor test files pass 40/40 after repair, including the
actual refocus hook obtaining context from the owned paired receiver. Six selected
Codex content-trust cases also pass (27 unrelated cases filtered), preserving
untrusted/modified installation decisions. Node syntax checking passes. Both core
plugin manifests advance from 0.1.32 to 0.1.33 so the changed shipped hook has a
new distribution identity. No installed plugin, provider, real seat, credentials
or live runtime was updated; the final installed-package refresh remains needed.

The 26 changed-entry delta read is now reconciled, including this repaired
consumer/generator mismatch. It does not convert source-only rows, host-limited
symlink coverage or remaining full integration requirements into completion.

## Finite inventory freshness and outside-inventory deltas

A read-only refresh at `e080c22` reconciles 222 public entries from the older
`9bbed` finite candidate ledger: 196 source hashes are unchanged, 26 changed, and
none missing. It also identifies 35 changed production/authored-helper scripts
outside that candidate set. Those counts describe freshness and the original
inventory's limits, not test coverage; outside-inventory does not mean previously
unread, and unchanged source does not refresh an old acceptance claim.

This pass reads the changed lines in evidence protection, settings browsing,
projection planning, rig instantiation, runtime-switch materials and cwd
preparation. The reviewed resource paths consistently use the native directory
mapping; the other deltas retain native basename/YAML-case handling and named
absolute-path display with sensitive components withheld. No new defect was
established in those reviewed lines. This is not a full reread/acceptance of all
35 outside-inventory modules.

The related scoped suites pass 49/49, zero skipped: image evidence guard 12,
runtime-switch material planning seven, settings browser 16, and native resource
projection 14. They use owned files, SQLite and projection fixtures; the settings
checks refuse external calls. They do not perform an actual runtime switch,
provider start, complete rig instantiation, remote share access or deployment.
The current inventory and these results remain separate evidence axes; source-only
reviews and integration gaps elsewhere are not silently reclassified as complete.

A subsequent current-hash-bound record at `a103925` accounts for the changed
lines of all 35 selected outside-inventory files: six planning/protection,
six native install/receiver, nine CLI integration, five resource/library/hook,
two runtime projection and seven authored helper/launch-rendering files.
Some were implemented and verified earlier in this audit; the remaining deltas
were reread without establishing an additional defect. All hashes still match
the refresh, and the repository snapshot remains stable during recording.

The additional read confirms WinGet outcomes remain distinct from PATH readiness,
receiver proof requires stable known console descendants, and queue recovery keeps
its invocation-local endpoint restoration. Native resource paths use the same
mapping in projection and replay; platform-derived plugin manifests remain
separate from authored source. These are changed-line/source conclusions, not new
test passes or evidence that actual WinGet, console routing, provider hooks,
cross-host queues or deployed restore were exercised. Full module/integration
acceptance and reconciliation of the original 26 changed ledger entries remain
open; the finite delta review does not establish all-feature completeness.

## Native spawn failure cannot inherit success

Follow-up checks of the private scoped-shell bootstrap found its existing
terminating-error handling already refuses an unavailable selected shell.
An actual native fixture now verifies exit status 1 and removal of only its owned
bootstrap file in that case. With classic/managed/shim tests, the run passes
18 cases, zero failed; the one stock-psmux opt-in case is skipped in this run.
The separately recorded six-case Windows PowerShell/pwsh stock check remains
distinct evidence, not a skipped case silently counted as passed.

The four recently affected standalone script suites were also checked together:
installer, upgrade inspection/migration plan, script entry aliases and native
pollution helper pass all 24 cases, zero skipped. Their npm/CLI receivers and
test files are owned fixtures; this does not replace the installed tarball Gate
or claim network setup/provider acceptance.

At `8ca0059`, three owned missing-executable reproductions failed: the dynamic
paired-CLI forwarder, classic Windows launch and managed Windows launch all
could leave a previous `LASTEXITCODE=0` intact after `Process.Start` failed.
PowerShell printed the error and then the explicit exit-code propagation reported
success. The two existing successful shim/path cases still passed.

All three renderers now initialize failure status before preparation/start and
make launch errors terminating with `ErrorActionPreference=Stop`. A successfully
completed child replaces that status with its actual exit code. Classic and
managed preference changes stay in their script block; the forwarder runs in
its generated script scope. The Windows seat-bin identity advances to v5 so
older active shims are not rewritten.

The failure reproductions and launch/shim checks pass 14/14 after repair. Separate
synthetic credential/token and native restore-launch regressions pass 22/22.
The actual managed-child argv/environment check also passes (one selected case,
34 filtered), preserving the parent environment and literal empty/quoted words.
Daemon TypeScript passes. These checks use owned missing paths, synthetic data
and receiver processes; no actual provider, deployed session or credential is
used, and no process is retried after an unknown launch outcome.

## Native script entry identity checks

The new [entry identity fixtures](../../scripts/native-entry-identity.test.mjs)
pass three Windows cases. They copy the actual docs guard, packaged-plugin
version checker and gate consumer into owned directories, invoke each through
its direct path and a directory junction alias, and verify the expected nonzero
refusal. The docs fixture uses a tracked disallowed path; the other two exercise
missing archive arguments and absent Git HEAD respectively. Importing each alias
remains inert. The fixture uses an empty Git configuration and isolated home,
and creates no commit or shared gate verdict.

These checks found no new production entry-identity defect. They prove those
entry guards do not silently skip the tested alias invocations; they do not prove
full archive validation, leak scanning, successful verdict consumption, or
file-symlink permissions.

## Native continuity and stopped-seat restore evidence

At `8da36b5`, the three compaction/stub-runner files above pass all eight cases.
The spawned runner authors its own transcript, executes the real shipped
precompact hook and restore bridge, produces the packet/seat marker, emits the
additionalContext directive and stamps one-shot delivery. Identity refusal and
deterministic clock checks remain. HOME/USERPROFILE are isolated and inherited
OpenRig/Rigged endpoint/token variables are removed for this run; it does not post
to the deployed daemon or invoke a provider. This is real subprocess/hook wiring
with synthetic content, not provider-triggered compaction.

A separate source-frozen run at full HEAD
`8da36b5b127ef76fef858aa365cb6f7e46ef7706` passes 84/84, zero skipped:

- Native idle subset restore: three injected observation states preserve an
  existing shell/binding without killing or replacing its session.
- Restore preconditions: 23 cases, including owned native replay files and path
  aliases, retain missing-file/owner-root refusal ordering.
- Stopped-seat contract: 52 owned SQLite/mocked terminal cases retain decision
  guidance, preview/apply consistency and proved intentional-stop protections.
- Native Claude restore launch: six real Windows executable/Node and PowerShell
  fixtures preserve fresh/fork/resume/legacy-resume identities and settings,
  including explicit restore-read permissions. Provider readiness is injected;
  these receivers do not start Claude or access credentials.

Before/after HEAD and tracked-diff hashes match for the 84-case run. These checks
strengthen the native restore seams and Stop invariants; complete snapshot/service
restoration and actual provider continuity remain unverified. No existing rig,
seat, queue, Stop/hold record or deployment was changed.

## Actual pwsh scoped-shell and stock psmux checks

The scoped launch test can now include an explicit portable pwsh through
`OPENRIG_TEST_PWSH`, retaining Windows PowerShell 5 in the same run. With the
existing explicit `OPENRIG_TEST_PSMUX` opt-in, each shell gets its own temporary
HOME/USERPROFILE, psmux registry and random `-L` namespace. Default invocations do
not download tools or probe a user's psmux server.

An owned run with [official PowerShell 7.6.9](https://github.com/PowerShell/PowerShell/releases/tag/v7.6.9)
passed all six cases, zero skipped. The downloaded Windows x64 archive matched
its release SHA-256
`ce7484804c0f0ad4dda10c958e71acdaf7eebfb22505c1b480f89e0e9f1da94d`.
The direct-shell cases check environment clearing, selected multiline/Unicode
values, fresh pane identity, cwd and bootstrap-file removal, plus native cmd
semantics and unsupported-shell refusal. The two actual stock psmux 3.4.0 cases
exercise empty-server startup, first session, dead-pane respawn with a routed
native client, and interactive shell command delivery under Windows PowerShell
and pwsh respectively. Each named server is stopped by its fixture; the portable
tool directory was removed afterward. No global PATH/install, existing seat,
provider access, deployment or team state was changed.

This establishes pwsh behavior for those initial-shell workflows. It does not
prove live provider launch/compaction, arbitrary shell profiles, complete restore,
or every generated CLI shim under pwsh.

## Paired cmd CLI Unicode path execution

Extending the native cmd shim fixture to place the paired CLI in a Chinese path
reproduced a failure at `0eef221`: cmd decoded the UTF-8 batch-file literal using
its code page, and Node reported a different, mojibake module path as missing.
The PowerShell variant in the same file still passed. No console code page was
changed for this reproduction or its repair.

The batch file now contains ASCII only and invokes its Unicode/BOM PowerShell
sibling through `%~dp0`. That sibling starts the pinned Node/CLI and performs the
Windows argv encoding described below. The process-local `-ExecutionPolicy
Bypass` flag matches existing native helper launchers; it does not change a saved
execution policy or override a machine-enforced policy. No elevation or agent
permission-policy selection is involved. Inherited delayed expansion is disabled
inside the batch entry. Windows seat-bin identity advances to v4 so v3 and earlier
shims remain untouched for their existing users.

Both native fixture cases pass after the change. They check Chinese and literal
percent/bang installation paths, and exercise cmd-to-PowerShell-to-Node forwarding
of empty words, spaces, embedded quotes, backslashes, Unicode and a quoted
ampersand. The child retains the selected directory and exit code 7. Normal cmd
parsing still applies before a batch file is entered; the shim does not promise
to undo variable expansion or shell syntax evaluated by its caller. Daemon
TypeScript and whitespace checks pass. No terminal, provider, live seat or
installed deployment was used.

## Paired PowerShell CLI argument forwarding

An owned reproduction of the previous seat `rig.ps1` shim shows Windows
PowerShell 5 dropping empty arguments and changing embedded quotes/backslashes
while forwarding `@args` through its native call operator. Seven intended words
arrived as five changed words. The corrected reproduction uses a flat parsed
array; an earlier diagnostic accidentally wrapped it as a nested array and is
not used as the product-failure evidence.

The shim now encodes its dynamic words using Windows command-line quoting and
launches the pinned Node/paired CLI with `ProcessStartInfo.UseShellExecute=false`.
It preserves the PowerShell filesystem location, inherited handles and child exit
code. The script has a UTF-8 BOM for Windows PowerShell's non-ASCII path decoding.
Windows seat-bin identity advances from v2 to v3, leaving existing directories
unchanged rather than replacing shims another daemon may still use.

Actual native fixtures pass for empty words, embedded quotes, trailing
backslashes, Unicode and shell metacharacters; the paired CLI itself lives under
a Unicode/metacharacter path. They also verify directory reuse, preservation of
the older shim, and refusal without overwriting unexpected bin contents. The cmd
percent/bang-path test remains passing. The final focused run passes three cases
with 24 filtered/skipped, and daemon TypeScript passes. No seat, provider or live
installation was changed.

The broader four-file run before the final BOM/test adjustments recorded 52
passed, ten failed and 13 pending: eight failures were host file-symlink `EPERM`,
and two were POSIX `/bin/bash`/symlink-specific fixtures. Those two are now
explicitly POSIX-only; the native shim reuse/argv checks above are separate
evidence. This is not a claim that the full four-file suite is green or that
pwsh/Git Bash behavior was exercised.

## Installed upgrade dependency closure and native drain

The strengthened install Gate passed at frozen
`789cd01e61d4ce4872296974f43a4181136b679d` (2026-10-31 00:09:37–00:11:11 UTC).
Before/after HEAD and tracked-diff hashes match. In addition to the native build,
tarball install, SQLite ABI and actual `rig.cmd` daemon-subpath load, it compares
installed upgrade inspection, migration and `run-rig.mjs` bytes with their authored
sources. The installed migration `--help` successfully imports the real sibling
module without running inventory. This closes the package-dependency omission
risk introduced by extracting that module; it does not perform a real migration.
The build still reports dirty metadata because the protected untracked diagnostic
is retained. No leak-guard term rules were supplied; those term checks are skipped.

At the same source, the native Windows daemon-control and CLI stop-outcome files
pass all 25 cases. Four native cases exercise capability-directory access checks,
stale identity refusal, successor capability preservation and an owned child
crossing production `startServer` shutdown to a matching clean persisted receipt.
That child uses an isolated home/database, ephemeral listener and fixture startup
services. The other 21 cases inject lifecycle observations to check failed,
timed-out, missing/stale receipts, rebound state and repeated-stop behavior.
This is real native control transport and bounded shutdown-path evidence with
fixture services, not existing-fleet drainage, actual provider shutdown or a
deployment restart. Existing stop/hold boundaries remain untouched.

## Upgrade helper command paths and packed TUI execution

The complete upgrade-helper test file was subsequently run at `826a4da`: 31
passed, 17 failed, and two SQLite-tool-dependent cases skipped. Fourteen failures
occurred at native file/directory symlink creation with `EPERM`, before the
intended behavior could be exercised. They remain unverified; junctions are not
substituted for file symlinks. The other three were fault-injection fixtures
copying the migration script without its newly extracted sibling `run-rig.mjs`.
The interposed fixture writer now copies that real dependency too. All three
affected non-symlink cases pass when rechecked (47 unrelated cases filtered).
The fourth interposed site also keeps the dependency, but its symlink premise
cannot be exercised on this host. Product safeguards were not weakened.

The two backup cases were then checked using SQLite's official Windows x64
3.54.1 CLI in an owned temporary directory. The archive's SHA3-256 matched
`e171f3993a992edf076746926dd52b5e2ebfabaee38818e74987e1d8112ab987`, published
on the [SQLite download page](https://www.sqlite.org/download.html).
Both cases pass: the backup retains the fixture row, passes integrity checking,
leaves source bytes unchanged, and refuses an existing destination. The temporary
tool was removed afterward. There was no global install/PATH change or live
database access. These separate rechecks reconcile the observed failures/skips;
they do not make the full symlink-dependent suite green.

An owned native reproduction found that PowerShell's direct invocation of
`rig.cmd` expanded a `%VARIABLE%` sequence inside the installation path a second
time. The file existed, but both upgrade inspection and telemetry migration's
read-only inventory reported `The system cannot find the path specified.`
The regression tests failed 0/2 before repair and pass 2/2 afterward. They cover
authored/canonical migration scripts, an explicit shim path and PATH lookup,
Unicode, spaces, ampersands, percent sequences and exclamation marks, and retain
the caller's working directory and nonzero CLI exit status.

Both callers now share the shipped `run-rig.mjs` transport. It resolves the
application without executing it, invokes executable files directly, and passes
batch paths through one environment expansion to `cmd /d /v:off /s /c`.
The callers' fixed CLI words are validated before that batch invocation; arbitrary
shell arguments are refused. It does not use `CALL`, change cwd, or alter a user's
installation. Companion focused upgrade tests pass 3/3 with 47 unrelated cases
filtered; this is not the full migration-suite result. The skill mirror check
passes with the new dependency included byte-for-byte.

Separately, the packaged TUI build/extraction/demo-input script passed at frozen
`f9cab913f7f21d92e8d862e4b8b68864bea22d5d`, with unchanged tracked-diff hash before
and after. It exercised the packed Node entry and every delayed split of its
arrow/page/mouse input vectors. Dependencies came from an owned junction to this
checkout's node_modules, so this is packed-entry/input evidence, not an independent
installed dependency or interactive desktop acceptance claim. No real daemon,
provider, team, or desktop window was used. These checks predate the upgrade-path
repair described above.

## Paired local-reader deadline and setup checks

The native `local-reading-process.test.ts` now also runs an owned, deliberately
stalled Node helper. `readLocal` returns its failure after the existing five-second
deadline, and the test confirms the direct child has exited using observation
only. It does not kill a recovered PID or claim descendant-tree containment.
The paired reader/window test files report 38 passed, zero failed, and nine
Linux-only `/proc` viewer-discovery cases skipped on Windows. Window calls use
owned inert CLI fixtures; no desktop window is opened. The four setup test files
report 117 passed, zero failed; these are injected setup/provider fixtures, not
global tool installation, login, or actual team startup.

The subsequent native package Gate returned zero after building, packing,
installing in an isolated prefix, checking SQLite ABI and loading the daemon
subpath through `rig.cmd`. Its receipt is explicitly **sourceStable=false**:
the local-reader test was edited during the run, while HEAD remained
`55ea31bf3adeee178a4ba1c29c38bb84ba33a581`. This is successful execution evidence,
not a frozen current-HEAD acceptance receipt. A final source-frozen refresh is
still required after implementation and audit work finishes.

## Experimental native Windows installer entry

The optional POSIX `scripts/install.sh` wrapper has a native Node counterpart:

```powershell
node scripts/install-windows.mjs --dry-run --package C:\path\to\openrig-cli.tgz
node scripts/install-windows.mjs --package C:\path\to\openrig-cli.tgz
```

Use a tarball built from this experimental branch. Omitting `--package` selects
`@openrig/cli`; a published version may not contain native Windows support.
This entry does not change the official support status or the documented WSL2 route.
The preview executes no subprocesses. Execution checks Node/npm, installs globally
through npm's JavaScript entry, resolves that installation's CLI, runs its ABI
checker when available, and invokes `setup --dry-run` followed by `setup`.
Setup can install tools and write defaults; the wrapper does not log in, elevate,
select a permission policy, or launch a daemon/team. It preserves failing stage
exit codes and distinguishes an installed CLI from incomplete setup. A missing
ABI checker is explicitly skipped, never reported as a compatibility pass.

Native owned-prefix fixtures in `scripts/install-windows.test.mjs` pass 10/10:
literal paths containing spaces/metacharacters, inert preview/import, directory
alias execution, installed JavaScript entry selection, install/ABI/setup failures,
missing checker reporting, and refusal of an npm root outside the selected prefix.
They use a fixture npm implementation and do not establish real network installation
or provider setup acceptance. The first run exposed an uncaptured npm prefix/root
result; capturing those outputs fixes the observed failure. No user-global install
was performed for these checks. Existing package-gate evidence remains separate.

## Frozen package and actual native Claude hook refresh

At source `ec96b4f2237c0f73d7ffc52dce133b4e99da744a`, the native package Gate
passed with an unchanged tracked-source hash before and after execution
(2026-10-31 00:53:22–00:54:51 UTC). It built and packed the branch, installed
into an isolated prefix, checked SQLite ABI and loaded the daemon subpath through
the installed `rig.cmd`. This includes the shipped plugin version `0.1.33` and
the current native seat-shim resolver. It is package acceptance within that scope,
not deployment or whole-workspace acceptance. The Gate reported that term leak
checks were skipped because no rules file was supplied.

An owned initialize-only fixture also exercised the actual native Claude Code
`2.1.304` executable. Its debug trace identifies the projected PowerShell
SessionStart command and plugin, with exit status zero. An independent file
witness confirms execution through the pinned Node and the correct plugin root
containing Unicode, spaces and `&`. Three owned short/long/Unicode skills were
discovered; the configured loopback API received zero requests, and the client
exited zero. The temporary home, plugin and debug log were removed afterward.

An earlier stdin-reading witness produced no file despite a successful hook
response; its cause remains unproved. The absolute-path witness establishes
native hook dispatch and path handling only. It does not establish real provider
conversation, production hook input processing, compaction or restore acceptance.

The OMP resource-discovery gap also has a native loader witness at source
`08751449a9b87bfaf26426c1a14f10fd4abe9a32`: the published
`@oh-my-pi/pi-coding-agent@18.5.0` `loadSkillsFromDir` implementation, running
through Bun `1.4.2` with its matching Windows x64 native addon, discovered all
three owned short/long/Unicode resources with zero warnings and exit zero.
The explicit owned directory contains names produced by this branch's resource
mapper. This exercises the actual package loader, not a reimplementation.
The package's Bun requirement is `>=1.3.14`; it does not assert compatibility
with the newer package line requiring Bun `>=1.4.4`. Installation used an
isolated prefix with lifecycle scripts disabled; the required native addon was
installed explicitly after the initial optional-dependency omission was observed.
The prefix and its dedicated npm cache were removed after checking the result.
No CLI session, login, provider request or global installation occurred. Full
OMP session/restore acceptance remains separate from this discovery result.

## Context-store full-file native verification

The full recursion test file at `fff1fe0` initially reported 23 passed and four
failed. One failure was a test's POSIX-only `endsWith("packs/a")` expectation
against a native filesystem path. Comparing each full source path with
`join(root, "packs", "a")` (and the distinct `b` path) retains the physical
identity assertion; the file then reported 24 passed and three failures, all
at symlink creation with `EPERM`. Those cases remain failed, not waived.

The library-service, compose and remove files initially reported 31 passed and
one symlink-creation failure. The compose case combined symlink refusal with
non-directory refusal, so the former's setup failure prevented the latter from
running. Splitting them preserves both checks and independently establishes
non-directory refusal with unchanged file content. The compose file now reports
16 passed and one symlink-creation failure; together with the unchanged two other
files this is 32 passed and one failed. This adds actual native filesystem
coverage without substituting junctions, skipping permission failures, or
claiming installed context delivery.

## Spec library and workflow discovery full-file refresh

At source `301605a`, the complete spec-library service and route files pass
22/22 on native Windows, with no skips. They include real owned filesystem
rename checks for reserved names, long names, case changes, mixed-case YAML
extensions and rollback when an owned Windows reader refuses old-file deletion.
The complete workflow scanner, workflow routes, workflow-folder route and
workflow-spec-folder scanner files additionally pass 57/57 with no skips.
The native folder-alias case checks that removed rows are reconciled without
deleting neighboring entries. The source review confirms that directory
classification uses native `path.relative` boundaries and source keys normalize
Windows path spelling. These checks cover owned files, database fixtures and
in-process routes; they do not establish every installed authored-resource
combination or a live deployed daemon's library delivery.

## Installed authored-library filesystem operations

The package Gate now invokes an independent Node process that imports the
context-pack library, spec library and spec reviewer from the actual isolated
npm installation's `daemon/dist` tree. Under an owned path containing Unicode,
spaces, `&` and `%`, it composes a context pack, scans and resolves its ref,
reads its exact member bytes, removes it, and confirms the directory is gone.
It also scans an authored agent spec, renames it through the installed service,
and confirms both the new authored name and removal of the old file.

The first run exposed an incorrect probe expectation: composed members have
generated names such as `source-0001.md`, not the caller's provenance label.
After correcting that assertion, the full Gate passed at fixed source
`2b0c31cef0c11a06352cfd8573df35803f94b4ba` (2026-10-31
01:05:37–01:07:03 UTC), with identical tracked-source hashes before and after.
Build, pack, isolated installation, these resource operations, SQLite ABI and
the installed native CLI daemon-subpath command all completed successfully.
This closes the package-to-library filesystem gap for the checked operations;
live daemon delivery, every authored combination and fleet activation remain
outside this fixture. The Gate removes its owned prefix and home in `finally`.

## Native atomic replacement and registry write refresh

The complete atomic-text, native-ACL, config-atomic and host-registry-write
files ran against production source at `2b0c31c` (a documentation-only commit
followed during execution). They report 56 passed, three failed and nine skipped.
All three failures occur at file-symlink creation with `EPERM`; all nine skips
are explicitly POSIX-only checks. The 23 native ACL cases pass, including owned
seat-skill replacement, plugin migration, ignore-file reconciliation, synthetic
Slack state, recap archives and native refusal paths. The host-registry writer
passes all seven cases using owned files, including preservation of invalid
existing state and loader/write validation parity. No real registry, credential,
Slack endpoint or seat is used.

The config test matrix now labels `ConfigStore` and `SettingsStore` explicitly.
Previously `%s` formatted each constructor as its complete class source, making
native failure logs thousands of characters longer before the actual error.
This diagnostic correction retains the same stores, actions and assertions;
it does not waive the symlink failures or turn scoped ACL results into a
full deployment or cross-user permission claim.

## Capture-health probe namespace isolation

Review of the remaining source-only entries found that the Windows capture
health check supplied `-L` and `NUL` but inherited the caller's HOME and psmux
data environment. An injected executor confirmed that none of its create,
capture or cleanup commands supplied a child environment. No real default
server was accessed to reproduce that omission.

The native probe now creates one temporary home, sets HOME, USERPROFILE and
PSMUX_DATA_DIR for every command, and removes inherited case variants of those
keys plus TMUX/TMUX_PANE. Doctor and setup forward this explicit environment
through their production executors. The parent environment remains unchanged.
Successful cleanup removes the owned home; unconfirmed termination retains it
instead of forcing deletion. Temporary-home creation failure reports not checked.
POSIX command construction remains unchanged.

Focused checks cover the shared child environment, actual doctor/setup receiver
processes, failed creation with cleanup, and retention after unconfirmed cleanup.
The corrected stock psmux 3.4.0 fixture also passes with the Windows null device,
independent home/data directory, capture and cleanup; no default namespace or
deployment is used. CLI TypeScript passes. The native CI lifecycle step now
includes this corrected capture check. The concurrent CLI/TUI directory run
started before this production change, so it cannot be described as a frozen
acceptance run of this revised source.

The follow-up also pins `PSMUX_CONFIG_FILE=NUL` and tests inherited mixed-case
tmux/config environment keys. If native termination is unconfirmed or removal
of the owned home is refused, the helper returns a separate cleanup warning
containing the retained path. Doctor and setup display that warning without
overwriting the capture result. The doctor's mocked timeout path confirms the
warning reaches its JSON output; its test retires only exact captured fixture
homes because that executor starts no real child. Focused checks and CLI
TypeScript pass after this diagnostic addition.

## Frozen CLI/TUI and installed capture refresh

The CLI/TUI directory run at `c7b5ebf532e6a6164f3889b260feda1ea3f30b9d`
completed with unchanged HEAD and tracked-source hash (2026-10-31
01:20:59–01:31:31 UTC): 522 files, 7,331 tests, 7,218 passed, 19 failed and
94 skipped. All 19 failures occur at host-denied symlink creation (`EPERM`),
including fixtures whose expected containment diagnostic is preempted by that
denial. They remain unverified; the overall exit status is 1, not green.

The ACP connector file is explicitly excluded because its cleanup attempts
were already exhausted. A `list --filesOnly` preflight and the terminal report
both confirm its absence using `**/acp-connector.test.ts`. An earlier run's
project-root-relative exclusion did not match, and its source changed during
execution; that earlier result is retained only as a mixed-revision diagnostic.
No further ACP cleanup attempt is justified by this correction.

Two proof permission-bit assertions are now explicitly POSIX-only. The actual
Windows DACL and private-staging checks remain in the independently passing
native ACL file; skipping POSIX mode semantics does not waive Windows privacy.

At `f73b678fda5f2d411b8de67fc672c0d958329688`, the refreshed package Gate
passed with unchanged tracked source (01:32:04–01:33:44 UTC). Besides its
existing build/install/ABI/CLI checks, it imports the installed capture helper,
confirms one disposable environment across create/capture/cleanup, and invokes
the installed doctor/setup executors with an owned environment receiver.
These checks use no real tmux server or provider. This is separate installed
evidence, not a claim that the directory run covers every deployed workflow.

Additional complete native service files at `c7b5ebf` pass 14/14 for agent-image
library operations and 27/27 for starter resolution, native home selection,
runner-home fallback and built-in policy copies. They use owned registries and
files; no real user registry, credential or existing endpoint is accessed.
Policy byte/readonly-attribute checks do not establish cross-user DACL protection.

Four historical tmux-exec test files report 16 POSIX-only skips on Windows.
An independent actual Node receiver through the production native argv executor
therefore checks three narrower behaviors: exact 2 MiB stdout, empty/Unicode/
quoted/metacharacter arguments, and stderr retained separately from simulated
pane stdout on failure. It passes all three; no real pane or psmux server is
involved. The skips are not recategorized as passes.

The initialize-only Claude stdin investigation remains inconclusive: an
immediate file witness confirms the Node hook starts, but its stdin-end witness
is absent. Explicit PowerShell `$input` forwarding with UTF-8 encoding gives
the same observation, so that hypothesis does not justify a production change.
Both owned client runs make zero configured API requests and exit zero. Client
hook success and process startup still do not prove production hook JSON handling.

## Actual Claude stdin gap repaired with native exec form

A subsequent comparison using Claude Code `2.1.304` distinguishes the paths:
the PowerShell shell form starts the owned Node fixture without completing its
stdin witness, while direct Node exec form receives and parses the complete
SessionStart JSON (461 bytes). Directly spawning PowerShell also fails to
complete that witness, so adding a PowerShell argument wrapper is not the fix.
These are bounded observations for this executable, not a diagnosis of every
client version or every Windows stdin implementation.

The Windows projection now uses Claude's documented `command` plus `args`
exec form. The staging Node executable boots a finite Node forwarder, which
honors the seat's OPENRIG_NODE selection (otherwise its own executable), passes
the exact script/arguments and inherited stdin without a shell, and returns the
child's exit code. Spawn failure returns failure rather than falling back or
reporting success. The staging executable must remain available until the
projection is refreshed. Canonical shipped command recognition remains closed;
operator hook text is not translated. Core plugin version is now `0.1.34`.

An actual initialize-only run using this production projection confirms the
complete JSON event, paired Node and Unicode/metacharacter plugin root, three
owned discovered skills, zero configured API requests and client exit zero.
The native fixture exercises all 13 shipped commands and checks exit codes
0/2/7 plus refusal of a missing selected interpreter. No installed user plugin,
provider credential, running seat or deployment is changed. Real provider
conversation, compaction and production hook effects remain separate.

See the [official exec-form hook contract](https://code.claude.com/docs/en/hooks#exec-form-and-shell-form).
Related older upstream [stdin report](https://github.com/anthropics/claude-code/issues/36156)
and [exec-argument report](https://github.com/anthropics/claude-code/issues/90495)
concern different versions; neither establishes the root cause of this fixture.

The exec-form change passes 78 related native projection/vendor/core-route/trust
checks with no skips, plus daemon TypeScript. Its package Gate passes at fixed
source `41fc05c4551eb9767c8e3374d857900626c89634` (2026-10-31
01:39:39–01:41:09 UTC), with unchanged tracked source. An actual Claude
initialize-only witness then imports the package-assembled compiled projector,
confirms the assembled plugin is `0.1.34`, and receives the complete SessionStart
event through that projection. This corroborates the packaged compiled path,
not just the TypeScript implementation. It still makes zero configured API
requests and does not establish production hook effects or provider continuity.

## Complete snapshot/restore decision-chain files

At `259ccce`, the complete `restore-orchestrator.test.ts` (315 cases),
`agentspec-restore.integration.test.ts` (15), and `restore-honesty-d1-d6.test.ts`
(14) pass on native Windows: 344 passed, zero failed, zero skipped. These use
real owned test databases and snapshot/startup-context records, with controlled
runtime/tmux adapters. They add full-file coverage of snapshot selection,
recorded continuity, carried sources, stopped/held decisions and compensation;
they do not launch real provider sessions or existing seats.

Tracing the real stub route confirms that complete native launch/readiness
would enter the managed-runner OS identity and cleanup path. The previously
recorded three unsuccessful cleanup attempts remain a boundary; this review
does not authorize a fourth equivalent attempt under a different fixture name.
The independent spawned stub compaction/restore script witnesses and the
344 decision-chain cases remain distinct from full native snapshot restoration.

## Native permission-helper failed compilation cleanup

Full review of `windows-owned-text.ts`, including its C# implementation, found
that both compilation entry points created their private staging directory before
registering successful-helper exit cleanup. A controlled nonzero compiler exit
therefore left its owned partial output and directory. The new four-case fixture
first reports two passed/two failed, then four passed after the correction.

Confirmed nonzero exits and recognized never-started spawn failures now attempt
to unlink only that compilation's exact output and remove its empty directory.
Timeouts, signals, killed processes and unclassified outcomes retain staging;
the original compilation error is rethrown. Cleanup never recurses through an
unexpected entry. The fixture uses owned partial files and mocked compilers,
not a live PowerShell compiler or real auth data. Daemon TypeScript passes, and
the native CI verification step includes this fixture. This is independent of
the exhausted managed-runner cleanup investigation and does not reopen it.
The complete native atomic ACL file also passes 23/23 after the correction,
covering normal native helper compilation and owned file replacement paths.

The subsequent package Gate passes at fixed source
`0063530baa50b8a458df7398c4931e4eb58f4375` (2026-10-31
01:50:44–01:52:12 UTC), with unchanged tracked source. Its installed ABI, native
CLI, context/spec operations and capture-environment checks remain passing after
the failed-compilation cleanup change.

The finite inventory refresh at that source contains 222 public rows: 30 changed,
192 unchanged and zero missing, plus 36 changed source/helper files outside the
old inventory. Seven additional hash changes since the earlier reviewed snapshot
have explicit fix/evidence reconciliation. One private follow-up remains withheld;
neither its source nor the protected untracked diagnostic was read for this audit.
These counts are source freshness and bounded delta coverage, not exhaustive
feature acceptance or a refresh of all historical behavioral labels. Real-provider
continuity, remote integration, distinct-user permissions, host-denied symlinks
and visible desktop acceptance remain separate requirements and are not green
by inference from local fixtures.

### Actual Pi OAuth conversation continuity (2026-10-31)

The user-selected Pi Codex OAuth provider was exercised with installed Pi 1.4.0,
provider `openai-codex` and model `gpt-6.1-sol`, in an independent temporary
session directory. The actual SDK completed two conversation turns, manual
provider-backed compaction, and reopening the persisted session. A fresh random
marker survived both the compaction summary and the reopened model's reply.
The process exited zero at 10:23:50 UTC after starting at 10:23:10 UTC.

The fixture disabled tools, extensions, skills and workspace guidance discovery;
only synthetic test text was sent. It used the existing provider's normal OAuth
storage rather than making a credential copy or changing existing seat state.
This proves the scoped installed-Pi conversation/compaction/reopen path on native
Windows. It does not prove the OpenRig managed-runner lifecycle or full restore.
SSH/SFTP recovery verification is deferred by the user and remains unverified.

### Deployed native acceptance (2026-11-01)

The existing local deployment now uses public source `3e48a2e` plus retained
private policy overlays at runtime commit `940b64d`. Its actual daemon started,
answered `/healthz`, stopped with a clean shutdown receipt, and restarted.
The database integrity check passed; 301 local-overlay tests passed. The earlier
recorder failure did not reproduce with the deployment's dedicated temporary
directory; its original cause is not established. Paused-seat checks found no
potentially active protected sessions. Two stale active parked-owner consumers
were stopped; their readback showed no new firing.

The user confirmed that the newly opened deployment TUI window renders normally,
and that entering `:help`, pressing Enter and returning with Esc works. This is
actual user-observed rendering and command-palette keyboard interaction; full
page coverage remains a separate check.

The production Compose adapter exercised a real Docker 29.4.1 engine using an
owned project, existing Python image and loopback-only HTTP port. Start, status,
HTTP, logs and down/up recreation with retained named-volume contents passed.
The owned containers and volume were removed. This is service lifecycle and
volume continuity, not checkpoint export/import or full OpenRig restore.

The production Pi runner with installed Pi 1.4.0 and Codex OAuth reached READY,
delivered actual synthetic input to the provider, then resumed the same session
file and recalled the exact random marker. An initially incorrect fixture used
an OMP-only environment credential name; the passing fixture used Pi's supported
seat-local auth storage, with only a short-lived access token and native private
ACL. The token file was removed after stopping the owned tree. Teardown was
forced and does not establish graceful runner cleanup, terminal-pane delivery,
compaction through the runner or full snapshot restore.

Fresh native file and directory symlink attempts both failed with `EPERM`.
The installed WinGet binary runs (`1.29.380`); actual package installation and
agreement/alias behavior remain unverified. Distinct-user permission checks,
exhausted ACP cleanup, full restore and remote integration remain open.

### Actual Pi runner EOF drain repair (2026-11-01)

A real installed Pi CLI reached READY but remained alive for the 12-second
fixture bound after the runner's input pipe closed. The runner closed its line
reader without forwarding EOF to the RPC child's stdin. It now ends that input
stream once, allowing the runtime to drain and exit normally. The same actual
CLI witness exits zero in 25 ms after EOF. A native offline-child regression
also requires its explicit EOF-drained acknowledgement, so a later timer exit
cannot conceal a missing EOF delivery.

The real OAuth runner fixture subsequently completed input, normal zero exit,
reopening the same persisted session, exact marker recall and a second normal
zero exit. No process-tree force stop was used in that passing fixture; its
temporary native-private access-token file was removed. This supersedes the
forced-teardown limit for that specific Pi input/resume fixture, not ACP cleanup,
psmux-pane attachment or full snapshot restore. The related three-file run passed
125 tests with 12 platform skips before the added EOF-specific regression.

### Actual local Pi snapshot recovery and native launch repairs (2026-11-01)

An independent one-seat instance exposed three further native launch defects:
stock psmux rejected the Windows-only `ProgramFiles(x86)` name when duplicated
in its `-e` transport; managed-runner identity did not recognize the generated
scoped PowerShell parent; and Pi's routed launch/resume used `node` rather than
the pinned absolute executable. The fixes preserve the Windows-only name in
the private bootstrap, recognize only that fixed generated loader and its unique
later shell, and retain the pinned executable through the routing wrapper.
Stock scoped-launch checks pass 5/5, managed/scoped-parent checks 36/36, and the
native dispatch test moves from 3 passes/1 failure to 4 passes.

Using the real daemon, stock psmux, installed Pi CLI and real Codex OAuth access,
the owned rig then received one multiline message and persisted the provider's
marker reply. An explicit snapshot was captured, the rig was stopped, and
restore attempt 140 completed `fully_restored`. The restored runner had a new
launch ID but the same session ID and file; a new provider reply recalled the
pre-snapshot marker. The original test queue row remained exactly once, with
unchanged body, and SQLite integrity passed. The independent daemon stopped
cleanly and its temporary access-token file was removed. No production seat was
used. Earlier empty/unpersisted fixture snapshots correctly refused continuity;
those refusals are not counted as successful restores.

This closes the tested local Pi session/queue snapshot and real psmux multiline
delivery paths. It does not establish a combined Docker checkpoint restore,
other providers' full lifecycle, cross-user access, ACP companion cleanup or
SSH/SFTP. The deployed main instance retains the local policies and protected
paused-seat state; no original team was resumed for these checks.

### Combined service restore, WinGet and compiler scratch (2026-11-01)

A second independent one-seat Pi rig declared a real Compose service with a
loopback HTTP wait target and a named volume. After an actual provider reply,
snapshot/down/restore attempt 183 completed `fully_restored`. The HTTP marker
returned 200 with the retained volume contents, the same Pi session resumed,
and a new model reply recalled the pre-snapshot marker. The owned rig, container,
volume and temporary credential were then stopped/removed. This establishes the
configured service restart plus Pi recovery combination, not arbitrary service
checkpoint export/import or crash/power-loss durability.

WinGet's actual user-scope portable installer installed a previously absent
`BurntSushi.ripgrep.MSVC` package into an owned location with a unique command
name. The installed binary reported ripgrep 15.2.0; exact-package uninstall
succeeded. Existing jq was detected and left intact. This does not cover every
package architecture, machine-scope installer, agreement state or reboot.

The fresh package Gate at `d40ce0e` failed with unchanged tracked source when
PowerShell Add-Type reported a missing C# scratch file under the shared Windows
TEMP root. Both helper compilers now set child TEMP/TMP to their own already
private staging directory, without changing the parent environment. Focused
compile-failure and native ACL checks pass 27/27. A real helper compilation and
private write then succeeded while the caller still used the same shared TEMP.
The underlying host behavior is not attributed beyond those observations.

File/directory symlinks still return EPERM on this host. No developer-mode or
account configuration was changed. The user ran the prepared synthetic-file
check from a distinct ordinary Windows account and supplied its output:
`DifferentUser`, `PublicControlReadable`, `PrivateReadDenied` and `Pass` were all
true. This verifies cross-user read denial on the helper-created private file,
with a readable public file in the same directory as a traversal control. It
does not establish foreign-user daemon endpoint access or every DACL operation.
ACP companion cleanup retains its separately documented unresolved boundary.

After the compiler-scratch repair, the source-stable installed-package Gate at
`57adaae` passed build, pack, isolated-prefix install, SQLite ABI, installed
context/spec operations, capture environment forwarding and the real `rig.cmd`
entry. This remains scoped package evidence, not an all-feature acceptance claim.

### Developer Mode symlink acceptance (2026-11-01)

After the user enabled Windows Developer Mode, its live registry value was 1
and fresh file and directory symbolic-link creation both succeeded. This
supersedes the earlier host EPERM limitation for the tested process.

The selected 11 CLI files containing the formerly blocked symlink assertions
passed 183 tests with zero failures and 11 skips. The selected 10 daemon files
passed 287 tests with zero failures and 17 skips. The protected private diagnostic
was neither selected nor read. These are bounded native reruns, not a complete
workspace-suite result; skipped checks are not counted as passing coverage.

The daemon rerun initially exposed five fixture failures. The tar assertion now
compares the actual filesystem link target (Windows makes a root-relative target
drive-qualified), retaining the separate crafted-header assertion and rejection
check. Project-boundary fixtures set Windows TEMP/TMP alongside TMPDIR. Hook
execution fixtures use native PowerShell or the actual Windows exec projection,
an executable .exe link, and a PATH without Node. They retain Windows process
infrastructure: an independent probe showed a nearly empty environment returned
zero without delivering stdin to its native child. The repaired test verifies
the actual HTTP activity post, context file output and failure after removal of
the pinned interpreter. The hook file also passes independently, 21/21.

ACP companion cleanup remains unresolved. Remote SSH/SFTP recovery remains
explicitly deferred by the user. Neither boundary is closed by these results.

### Real Windows-to-Windows SSH/SFTP and remote persistence (2026-11-02)

The user resumed remote acceptance and prepared a second owned Windows host at
the same source revision, `c1ae79f`. Its ED25519 host fingerprint was compared
against the independently supplied host-side value before connection. Strict
verification remained enabled through a dedicated known-hosts file; public-key
non-interactive SSH execution succeeded.

The production native SFTP copy implementation then used real OpenSSH transport
to upload and download three synthetic files, including spaces, Chinese names,
a nested directory and a 131089-byte binary. Original, remote Get-FileHash and
downloaded SHA-256 values all matched. A repeated unchanged upload transferred
zero files. The first independent hash-report fixture needed explicit UTF-8
PowerShell console output; the transferred names and bytes already round-tripped.

An isolated remote daemon used its own home, loopback port and no kernel/team
startup. Existing workspace junctions were initially untraversable from the SSH
token; recreating only the four verified in-repository workspace junctions made
the CLI usable. A topology was materialized without launching sessions. Across
a real daemon stop/start, the PID changed and the same synthetic queue ID/body
persisted exactly once. A final read-only SQLite check reported integrity `ok`.
This is remote daemon/queue persistence, not provider-session snapshot recovery
or queue pickup/delivery; the synthetic destination was not a running seat.

Two lifecycle limits remain explicit. A daemon reported started inside SSH was
absent after that SSH session ended; the termination mechanism is not established.
HTTP readiness also preceded publication of the native control capability, so
the bounded persistence fixture waited for that file before stop. The first
stop/restart completed successfully; final teardown observed PID absence and
no listener, but reported no matching clean-shutdown receipt. That final drain
is unverified. No remote provider credentials were read or copied, and no remote
real-provider continuity or full-session restore is claimed. The owned daemon
and listener are stopped; existing teams were not started.

### Rebased main integration (2026-11-02)

The Windows branch was rebased onto upstream main
`860d352556986151eed96d0cc8af62cfed8a5520`. Integration retains main's explicit
tmux-server selection and attachment metadata alongside native psmux routing,
the shell-independent attach probe alongside literal socket whitespace, and
main's process/restore diagnostics alongside native executable identity checks.
The projected plugin fingerprint uses the expected shipped bytes after strict
comparison, preserving the source-authority check.

All workspace type checks pass. Latest receipts across 21 selected integration
files report 730 passed, zero failed and six skipped; these cover the reconciled
terminal/server, attach/help, process identity, restore trust, compaction and
fixture boundaries. This does not rerun or renew the earlier real-provider,
installed-package or remote lifecycle acceptance claims against the new base.
No deployment was changed by this rebase.

### Remote lifecycle repairs and remaining provider dependency (2026-11-02)

Remote shutdown logs established a clean receipt whose callback timestamp was
seven milliseconds before the CLI's request timestamp. Matching a native stop
now uses a random per-request ID carried through the authenticated instance
pipe into the receipt, rather than cross-process wall-clock ordering. PID,
capability and boot-state validation remain required; missing or different
request IDs do not prove that request's drain. POSIX and legacy callers retain
their existing time-based checks. HTTP health stays at 503/starting until the
Windows control capability has been published, preventing premature CLI success.

Two real remote startup/stop rounds returned only after control readiness,
preserved the queue and produced matching request-bound clean receipts. These
supersede the earlier missing-receipt result for the repaired path. The remote
witness uses the original `c1ae79f` checkout plus the exact lifecycle patch;
local build/type checks use the rebased main tree.

The remote SSH process belonged to a kill-on-close Job with explicit breakaway
allowed (observed flags 0x2800). Native daemon startup over Windows SSH now
re-execs only its finite startup CLI using CREATE_BREAKAWAY_FROM_JOB, then runs
the existing startup identity/lock checks normally. It retains stdout/stderr,
native argv, cwd and the caller's TEMP/TMP; the recursion marker is not passed
to the daemon or seats. No task scheduler, service or WMI fallback is installed.
A real SSH start returned; after disconnect, separate SSH invocations read the
still-running daemon and unchanged queue, then stopped it cleanly. PID absence,
zero listeners and removal of matching state were verified. No original team
was started. This supersedes the earlier SSH-disconnect survival failure for
the repaired tested host.

The five selected lifecycle files pass 135 tests without skips; workspace type
checks pass. A proposed prohibited-job fixture failed to establish its expected
host precondition and was withdrawn after bounded investigation, so denial by
every nested-job policy remains unverified. Native startup errors have no broker
fallback. Actual remote Pi 1.4.0 Codex OAuth readiness reported ready, but the
first isolated, tools-disabled provider request failed with `refresh_token_reused`
(401). That account needs a fresh interactive Pi login before remote provider
continuity/full-session restore can be completed. No credential was printed or
copied. ACP companion cleanup remains separately unresolved.

### ACP companion fixture teardown repaired (2026-11-02)

The full ACP connector file now passes 23/23 without skips, including its
afterEach directory removal. The detached-companion test still requires the
process to survive the ACP connection and still requires the connector's
incomplete-process note; product ACP behavior is unchanged.

Previously teardown sent SIGKILL by PID and immediately removed the fixture
directory. The test companion now accepts a test-owned synthetic stop file,
acknowledges its PID, reason and original cwd, then exits normally. Teardown
checks that acknowledgement, verifies the cwd still resolves to the original
fixture directory, and observes ESRCH before removing the files. No retry loop
was added to directory deletion, and the companion was not moved elsewhere to
hide a directory hold.

Read-only inspection of the old retained roots found native DELETE access
available and deletePending=false; no matching cwd was found among readable
candidate processes, including canonical short-path comparisons. This does not
identify the old force-stop EPERM's exact handle/OS cause. The passing result
establishes the corrected fixture lifecycle and supersedes the earlier ACP
cleanup failure for this file, not a product shutdown fix or broad ACP matrix.

### Native retained-state durability and server selection (2026-11-02)

Environment checkpoints and exported artifacts formerly fsynced read-only Node
handles; Windows returned EPERM, including the directory publication barrier.
They now use the existing private native helper to acquire a writable handle,
verify the selected file/directory type and current owner, reject final reparse
points, and call FlushFileBuffers. Environment state directories receive the
native owner-only inheritable DACL. Flush failures still fail the operation;
POSIX keeps its file/directory fsync path. Three direct barrier/refusal tests
and 62 environment lifecycle/platform/startup/HTTP export checks pass. This
establishes the selected API paths, not a physical power-loss experiment.

Windows `terminal.tmux_server=isolated` now selects and persists a per-home -S
path instead of returning inherit. Execution and new-terminal metadata use the
same path. Existing live registered sessions and unavailable observations retain
the previous selection; no session is moved, restarted or killed by selection.
The inspector uses a nonempty suffix to retain an empty owner field when psmux
trims trailing whitespace. Malformed replies still remain unknown.

An actual stock psmux 3.4.0 witness starts equal session names in two selected
homes, captures distinct receiver markers through the production adapter, reads
each namespace through its attachment metadata, reopens the durable selection,
and observes neither from a default client. A real server inventory prevents a
requested migration with the old session alive. Stopping one session leaves the
sibling readable. The witness and complete selection file pass 43 tests with
two POSIX symlink skips; the wider five-file selection/terminal subset passed
68 with two skips before the inspector suffix follow-up. Daemon and CLI type
checks pass. No existing daemon or team used the changed selection.

### Binary SFTP command-path planning (2026-11-02)

The ordinary native Windows copy planner now accepts Unicode, spaces and
absolute `/C:/` paths for binary SFTP. It rejects relative paths, traversal,
control characters, backslashes, alternate-stream colons and protected directory
segments including Windows case/trailing-dot aliases. These paths are protocol
strings, not shell commands. The rsync builder separately rechecks its original
shell-inert path grammar, preventing a wider SFTP plan from reaching that shell
transport through an injected executor or other caller.

The path/planner, file-transfer, SFTP-copy and protocol set passes 60 tests with
three skips. Per-file reconciliation confirms both local SFTP-copy tests and
all three protocol tests passed against the installed Windows SFTP server;
the three skips belong to separate file-transfer tests. An earlier report
incorrectly inferred missing SFTP coverage from the aggregate skip count.
The existing real remote transport receipt predates
this planner change and exercised the executor directly; it does not renew the
ordinary CLI end-to-end acceptance. Archive metadata equivalence remains open.

### Windows rootless engine observation (2026-11-02)

The existing `--engine-socket` option now also accepts a local Windows named
pipe. A native client handle supplies the real pipe server PID; a process token
must match the caller SID, and the retained identity includes process creation
time. Remote pipe names and malformed paths refuse before connection. Inventory
still only reads the selected endpoint, with bounded HTTP bodies and deadlines.

Windows additionally requires `/libpod/info` to confirm a Linux rootless engine
with a nonzero mapped host UID, hostname and storage root. Their fingerprint is
retained with the pipe witness. Capture and absence observation both recheck the
pipe; a changed owner/process or engine fingerprint, a rootful engine, missing
inventory, or failed volume query cannot establish cleanup. Exact workload,
supervisor and volume attribution retains the Linux rules. No engine mutation,
machine startup, default-connection change or global-empty requirement is added.

Three observer tests now execute the production HTTP reader over a real owned
Windows named pipe, using synthetic Podman responses. They check the native
server PID/SID, exact capture, unrelated-resource retention, changed engine and
rootful refusal. Together with lifecycle and driver checks, 35 tests pass without
skips. The helper's existing file/auth/flush regression checks also pass. This is
real native pipe/process observation with controlled engine data, not actual
Podman/OpenShell deployment acceptance: Podman is not installed on this host.
Cross-user pipe refusal and actual guest engine deletion/recovery remain untested.

The Windows pipe route follows Podman's documented [Windows API pipe](https://github.com/containers/podman/blob/main/docs/tutorials/podman-for-windows.md)
and [rootless info fields](https://docs.podman.io/en/latest/markdown/podman-info.1.html).

### SFTP representable permission metadata (2026-11-02)

Native SFTP downloads now apply the source permission mode after timestamps,
preserving the Windows read-only/writeable attribute without replacing the
destination DACL. The file quick check also detects permission-only drift;
preview reports it, and execution repairs it without retransferring file bytes.
POSIX endpoints compare permission bits, while a Windows local destination
compares the owner-write bit that native chmod can actually represent. This
does not claim Windows enforces POSIX group/owner/execute permissions.

The four-file set passes 61 tests with three unrelated skips, including real
SFTP subsystem upload/download using the normal planner for drive/Unicode/space
paths, readonly retention, metadata-only preview/repair, safe readonly-replace
refusal, malformed framing and handshake timeout. This run explicitly uses a
task-local official Win32-OpenSSH 10.4.0.0p1 Preview portable server with a valid
Authenticode signature; nothing was installed as a service or added to PATH.
The earlier installed-server five-case SFTP receipt remains independently valid.
CLI type checking passes. Full archive owner/group/execute, ACL and special-file
semantics, and renewed cross-host ordinary-command acceptance remain open.

### Stock psmux initial/respawn environment privacy (2026-11-02)

The stock-backend path no longer falls back to literal `-e KEY=value` arguments
after an explicit unsupported-capability reply. It stages the initial child
environment in the native private bootstrap, strips the assignments from the
psmux command, then persists session values with a protected source-file. The
existing scoped bootstrap is reused when present; inherited launches use a
bootstrap that retains their normal server environment. The versioned candidate
protocol remains supported. No unavailable/uncertain capability reply authorizes
literal transport, and uncertain launch/update calls retain files without retry.

The bootstrap handles PowerShell, pwsh, cmd and named POSIX-style shells such as
Git Bash with their respective command switches. Actual Git Bash inheritance
and literal Unicode/newline values pass on Windows. Unsupported shell semantics
fail private environment launch instead of exposing values in argv.

An owned stock psmux 3.4.0 witness verifies the first child and a dead-pane
respawn receive exact synthetic values, normal inheritance survives, session
values persist, mixed-case keys work, and recorded production client arguments
contain neither literal values nor `-e` assignments. The complete five-file
native set passes 22 tests without skips; two subsequently added uncertainty
cases also pass. Daemon type checking passes. A wider four-file environment
regression observation has 30 passes and five failures: two hardcoded `/bin/bash`
spawns and three separate-interpreter adapter fixtures. They remain open leads,
not waived regressions or evidence of complete platform equivalence.

Session values are committed after child creation: arbitrary creation hooks
requiring them before launch have not been qualified. Additional user panes,
external respawn commands, other shell implementations, existing live fleets
and the rebased installed runtime still require acceptance. No running instance
or stock psmux binary was changed by this source repair.

### Native child-tool PATH parity (2026-11-02)

Three actual Windows launch witnesses reproduced a behavioral difference: the
runtime/interpreter were pinned correctly, but child tools received the daemon
PATH instead of the pane's post-startup PATH. Native seat commands now resolve
the runtime against the selected daemon PATH first, then prepend only the paired
rig directory to the pane's runtime PATH. The separate managed-environment
renderer retains its explicit managed PATH contract.

Actual fresh/resume/fork Codex-adapter witnesses use a synthetic recognized npm
entry, a separately located Node interpreter, a pane PATH with neither, and an
owned paired CLI. The real capability probe and generated PowerShell launch
execute; the child sees exactly paired-rig plus the pane tool PATH, and a second
PowerShell process executes that paired rig successfully. Interpreter identity
is checked through the actual filesystem target. Combined with the existing
native argument/home tests, all five native cases pass.

The six-file environment set passes 35 checks with 42 explicit platform skips.
The five original failures were POSIX runtime fixtures; their shell/shebang
checks remain enabled on POSIX, with native pin/PATH/rig behavior exercised by
the Windows witnesses instead of classifying those skips as passes. The newly
supported Bash private loader also supersedes four old null-plan expectations;
their no-credential-in-argv assertions remain. Daemon type checking passes.
This closes the observed native PATH difference, not full same-head platform
validation or real provider acceptance.

### Complete CLI/TUI observation and remaining leads (2026-11-02)

The complete CLI/TUI directory run at unchanged Git head `0b0df4c59ddde1af62ca8e7342afebb2b87c131b`
finished from 03:46:55 to 03:56:24 UTC with 7,376 passes, three failed assertions
and 92 pending tests (7,471 counted assertions), plus two collection failures.
It includes the repaired ACP connector. No provider or stock-psmux opt-in was
enabled. The tracked Git diff hash was empty before and after; this is Git
source stability, not a hash of every physical checkout byte or dependency.

All five failed files now pass their complete targeted run, 100/100:

- The lazy loader's environment command was in a different position from the
  complete command factory. Its order now matches without removing a command.
- The real held-body doctor fixture registers only its own bound loopback
  origin, preserving the fetch guard and bounded unknown-owner assertion.
- The file command fixture retains POSIX charset refusal and explicitly checks
  native SFTP space-path acceptance and transport-specific JSON. Its old mock
  omitted the transport label; production native SFTP already supplies it.
- Both collection failures imported check-abi.mjs from a stale CRLF worktree
  despite the existing LF Git attribute. Node parsed it, but the test loader
  rejected that checkout representation. Restoring LF makes both complete
  files pass (30 checks); no ABI policy was changed. Git index/source bytes
  were already LF, so this is a checkout correction, not a new script algorithm.

The full directory run has not been repeated after these repairs and is still
recorded as exit 1. Its scoped passes do not close the full goal. Read-only
follow-up also confirms ordinary SSH execution unconditionally uses `sh -lc`;
the earlier real Windows SSH scripts did not cover that CLI front door. An
explicit native remote execution route remains required. Remote real-Pi OAuth
continuity is deferred at the user's request pending a fresh interactive login.

### Explicit Windows SSH command execution (2026-11-02)

SSH registry entries may now select `remoteShell: powershell` and an absolute
remote JavaScript `rigPath`. `rig host add/edit` expose `--remote-shell` and
`--rig-path`; CLI and daemon registry readers/writers preserve and validate the
same fields. An absent selection retains the original POSIX login-shell path.
The remote OS is never inferred from the caller's platform.

The native route uses a fixed encoded PowerShell bootstrap and structured
CreateProcess arguments. A rig command runs `node.exe` with the configured
entry, avoiding npm/cmd shim argument loss; Node must be on the remote SSH
process PATH. Native executable resolution is explicit and an unavailable
executable exits 127. Derived origin identity is supplied only to the child,
stdin remains available to it, and its actual exit code is preserved. The SSH
authentication/configuration and host-verification behavior is unchanged.

For example, an owned Windows entry can contain:

```yaml
id: windows-test
transport: ssh
target: your-existing-ssh-alias
remoteShell: powershell
rigPath: C:/your-install/node_modules/@openrig/cli/dist/bin-wrapper.js
```

Use the actual installed JavaScript entry on that host; the sample path is not
discovered or installed automatically. This does not translate arbitrary POSIX
programs used by separate host-posture checks into Windows commands.

The native SSH/registry/paired-launch set passes 47 tests with three remote
opt-in skips. A subsequent explicit missing-executable native test also passes;
the complete native command file is 5/5. These run real local PowerShell while
substituting the SSH process, proving exact empty/Unicode/quote/newline argv,
stdin, origin and exit 0/7/127 behavior. The existing POSIX SSH and registry
regression set passes 135/135; CLI type checks and daemon compilation pass.

Actual remote opt-in tests are prepared for the owned Windows endpoint. The
synthetic receiver upload did not complete: SSH to the existing host timed out
before authentication (exit 255). Therefore no real remote command or remote
rig-version pass is claimed for this change. The failed upload did not start a
daemon or team. This is a separate dependency from the user's deferred Pi login.

### Native Herdr endpoint foundation, qualification still open (2026-11-02)

The earlier blanket assumption that Herdr is unavailable on Windows was wrong.
The official v0.9.5 release contains a Windows archive; its SHA-256 matched the
release asset digest. The task-local portable copy retained its ConPTY runtime
and was not installed, put on PATH, or used to start an OpenRig team. A real
owned headless instance reports version 0.9.5/protocol 22. See the official
[Windows support](https://herdr.dev/tui/docs/windows-beta/) and
[v0.9.5 release](https://github.com/herdrdev/herdr/releases/tag/v0.9.5).

OpenRig now maps the Windows socket marker path to Herdr's named-pipe endpoint,
instead of attempting a Unix socket connection to that file. Native config
resolution uses Roaming AppData unless XDG_CONFIG_HOME is explicitly selected;
case-insensitive overrides and session markers are handled without changing
the caller environment. The CLI runner finds herdr.exe through a native PATH
and removes inherited session/socket aliases before pinning the exact endpoint.
RPC completion waits for the client socket/pipe close event.

The real native witness completes protocol checks, independent default/named
endpoint checks, explicit-socket CLI routing despite mixed-case stale markers,
and named-server stop while the default endpoint stays alive. Both owned
servers report normal exits. These do not yet qualify the viewer/follow engine:
the Linux-only process/attach verification, explanation strip, private journal
and desktop launch paths still require a native implementation and acceptance.

Validation remains failing because the witness's final directory removal
intermittently reports EPERM. One two-file run passed 8/8 including cleanup;
the subsequent four-file receipt has 18 passes, one cleanup failure and three
POSIX runner skips. Waiting for child close, canonicalizing the path, and
waiting for RPC close did not establish a stable cleanup result. No deletion
retry count was increased. Directory/link/ACL inspection and a read-only native
DELETE-access probe found no continuing refusal after the failed worker ended;
an exact previously failed root was subsequently removable by a separate Node
process. That does not identify the live handle or OS cause. After the bounded
repair attempts, this cleanup issue is retained for evidence-led investigation;
the assumption that observed exits imply immediate deletability is unproven.
The test preserves any original body failure alongside cleanup failure.

Daemon type checking passes. The earlier statement that awaiting pipe close
resolved the cleanup root cause is superseded by the later failure above.
No complete Windows Herdr/following, desktop or reboot claim is made.

### Native Herdr viewer preparation — 2026-11-02

The viewer can decode only this build’s exact Windows tile wrapper and inspect its psmux server/session/node binding without evaluating its PowerShell text. Native cwd attribution accepts Herdr’s case/separator spelling and trailing separator while rejecting sibling and relative paths. Shell command rendering supports quoted PowerShell and POSIX shells; cmd remains unqualified because Windows argv quoting does not prevent cmd expansion.

Validation: native viewer preparation plus existing viewer state-machine tests: 24/24 passed. Daemon typecheck passed before the cwd-only follow-up. The Windows viewer/follow entry remains gated: native private journals, foreground attachment verification, following explanation strip and desktop launch still require implementation and real acceptance. This does not resolve the separately recorded Herdr fixture cleanup EPERM.

### Native Herdr viewer state machine — 2026-11-02

Windows viewer provisioning now uses current-SID private directory DACLs and private atomic journal replacement. Before pane run it requires one foreground process whose PID equals the reported shell PID, then renders the exact tile argv through a supported shell. Native psmux foreground verification uses the decoded server/session binding. Windows is admitted by the viewer state machine; CLI desktop/follow entry remains separately incomplete.

Validation: 26/26 targeted tests passed, including Windows private filesystem writes, case/trailing-separator provider cwd readback, verified attach, and journal reuse across viewer object restart without duplicate create/run. Daemon typecheck passed. The new state-machine provider is controlled: this is not a claim of real Herdr plus psmux desktop acceptance. cmd shell, following strip and real end-to-end acceptance remain open.

### Native following explanation strip — 2026-11-02

Windows following now runs the shipped Node explanation helper instead of /usr/bin/tail, after confirming its owned pane still has a sole supported foreground shell. It reopens the private log by name, shows its last 30 lines and observes atomic replacements. Canvas, viewer and event journals use Windows private DACL creation and atomic publication. Native cwd spelling is accepted without changing the shared following policy for membership, draft retention, focus, pins and uncertain effects. Three existing following fixture checks now use platform path components instead of POSIX-only slash substrings.

Validation: six complete targeted test files, 64/64 passed; daemon typecheck passed. A real Node child observed initial/truncated Unicode output and log replacement; controlled Windows provider state confirmed an empty qitem canvas and helper identity survive object restart without duplicate create/run. The package-content proof now asserts the new helper is an exact regular-file copy, but the heavy build/pack gate has not yet been rerun on this change. Real Herdr+psmux desktop/follow interaction and native CLI launch remain unverified/incomplete.

### Native Herdr CLI and layout routing — 2026-11-02

Explicit Herdr/named-session/following window requests now reach the shared CLI flow on Windows, with native herdr.exe discovery, interactive-desktop/CI/SSH checks, a new Windows Terminal surface, and encoded structured PowerShell environment execution. The daemon-selected socket remains authoritative; following confirms the endpoint before tab lookup/focus. Windows config discovery honors APPDATA/XDG and keeps personal config precedence. Native one-shot layout and restore argv use PowerShell wrappers, carry agent/tile hints, and use native blank panes. Existing-window reuse reads psmux client inventory against the decoded exact server/session/read-only tile binding.

Validation: four complete window/layout/restore files, 112/112 passed. Real PowerShell execution preserved literal Unicode/quote/metacharacter argv, removed the stale Herdr session and returned child status 7. Controlled Windows following launch confirmed one window request and exact-endpoint focus. Daemon build and CLI typecheck passed after refreshing daemon declarations. This is implementation and scoped evidence, not real Herdr+psmux desktop/follow acceptance; installed package proof and same-head Linux/Windows full validation remain pending.

### Real Herdr/stock psmux acceptance found a remaining attach gap — 2026-11-02

At source head 1acdbfb, isolated real Herdr 0.9.5 and stock psmux 3.4.0 started successfully. The generated Windows tile queried the exact -S server session ID and node identity successfully, but stock psmux attach -t  returned status 1: cannot find its namespace-prefixed session. The viewer correctly stayed unconfirmed and did not repeat pane run. Increasing only readback observation did not resolve this. This contradicts readiness of the newly implemented native viewer path; controlled state tests do not cover this stock-server behavior.

A task-local instrumented helper experiment using =name produced a read-only psmux client, but Herdr still reported only its shell foreground; it did not prove a correct in-pane attachment. No name-based production fallback was applied: identity continuity and exact in-pane attribution remain unresolved. Further work must address both the stock namespace/ID behavior and real process/console attachment. All owned Herdr servers stopped with exit 0; the source seat survived each Herdr stop before the task-owned psmux server was stopped. This was headless control/process acceptance, not a visible desktop confirmation.

### Do not hide native attach failures — 2026-11-02

The Windows tile helper now preserves a nonzero managed attach exit immediately, writes an actionable failure to stderr and does not reinterpret the later unchanged session as a successful detach. Previously it discarded the attach result and could return 0 after its retry observation. Two complete targeted files passed 7/7, including a real PowerShell helper process with attach exit 7 and proof that only the initial snapshot, identity and one attach were invoked. Existing replacement-following/foreign-identity cases also passed.

Stock psmux v3.4.0 source investigation (https://github.com/psmux/psmux/blob/v3.4.0/src/main.rs) shows its attach-specific name resolution adds a namespace prefix after ID resolution, unlike the general namespaced target handling. An isolated task-local experiment without the attach namespace flags retained ID targeting and established a read-only client; it still failed Herdr foreground attribution. A native PowerShell invocation experiment also failed that complete qualification. These experiments were not adopted as production fixes. After three incomplete console/target experiments, further trial changes on this path stopped; the assumption that the present nested launch keeps a usable in-pane interactive console remains unproven. The broader parity goal continues on other independent gaps.

### Native SFTP readonly replacement equivalence — 2026-11-02

Native SFTP download replacement now uses a Windows ReplaceFile operation for an existing ordinary file. It temporarily clears readonly through pinned file handles, preserves the destination DACL, takes the staged source readonly state, and restores readonly on any retained old hardlink inode. Failure restores attributes through the original handles and remains a local-copy failure with the original destination/staging recovery contract. Symlink and new-file paths retain their separate rename behavior. The former test that expected ordinary readonly replacement to fail was replaced by positive real-subsystem checks for both writable and readonly source metadata.

Validation: four complete SFTP/planner/native-helper files passed 20/20. The installed Windows SFTP subsystem copied new bytes over readonly destinations, retained old hardlink bytes and readonly state, adopted both source readonly settings, and left no staging file after success. Daemon build and CLI typecheck passed. This closes ordinary readonly replacement; POSIX owner/group/execute enforcement, ACL transfer, special files and directory metadata parity remain separate open requirements.

### Native SFTP directory metadata preview — 2026-11-02

Existing-directory mtime and representable permission drift now appear in the SFTP dry-run itemization, instead of silently changing only during execution. Directory times are restored after child copies, preserving the parent timestamp even when new children were created. Windows local directory readonly is not treated as POSIX write permission: chmod is omitted for that directory attribute, whose Explorer meaning is not access enforcement. POSIX/remote directory permission updates retain their existing operation.

Validation: three complete SFTP/protocol/planner files passed 20/20. Against the installed real Windows SFTP subsystem, nested directory drift was reported twice without writing, execution copied the new child and restored both parent timestamps, and the repeated preview reported no changes or transferred files. CLI typecheck passed. Owner/group/execute enforcement, directory ACL semantics and special-file equivalence remain open; this change does not resolve them.

### Native viewer cwd identity and external respawn audit — 2026-11-02

Windows viewer/follow cwd attribution now requires the live directories to share a nonzero filesystem inode and device, instead of accepting lowercased path equality. This preserves normal case/trailing-separator aliases while not conflating distinct directories on case-sensitive Windows directories. Missing paths and non-directory identities remain unconfirmed. Four complete viewer/follow files passed 27/27 using real native directory identities and private journals; daemon typecheck passed. A host directory with case sensitivity explicitly enabled was not exercised, so that particular host configuration is not claimed as acceptance.

Independent stock respawn audit confirmed the Windows scoped loader reads then removes its bootstrap, while an external respawn with no command reuses the stored creation command. This remains an implementation gap. Keeping the secret bootstrap indefinitely is not adopted as a workaround: a durable recovery command needs current session-environment semantics, private persistence and exact stop cleanup together. No existing seat was respawned during this read-only audit.

### Stock inherited launch recovery without retained environment files — 2026-11-02

Stock inherited-mode private launch now stores a recovery script in a randomly named session-environment entry through the existing private source-file channel. The loader argv contains only the entry name and one-time initial path. Initial environment assignments remain in the consumed private file; the recovery script uses current session inheritance instead of embedding their old values. Reserved recovery records are removed from the launched child environment. The record is owned by the psmux session/server environment and ends with that server; no durable recovery file, watcher or cleanup timer was introduced.

Real stock 3.4.0 acceptance passed initial launch, explicit respawn, then external raw respawn-pane with no command after the bootstrap was consumed. It ran the stored command with the newly updated session value. Values stayed off multiplexer argv and launch calls contained no literal -e assignments. Three scoped/cleanup/parent files passed 14 tests with one pre-existing opt-in case skipped; the independent real stock test passed one test. Native PowerShell helper recovery additionally confirmed a consumed file stays absent, scoped allowed values update, unrelated inheritance remains excluded, recovery records stay out of child environment, and missing recovery fails closed. Daemon typecheck passed.

Production scoped-policy wiring remains incomplete: its permitted baseline values and Windows non-identifier environment names must persist with current-value semantics before enabling this recovery path there. Creation-hook timing, native Herdr attachment and full parity acceptance remain open.

### Scoped-policy native recovery integration — 2026-11-02

Scoped Windows launch and explicit respawn now persist their allowed baseline/session assignments through the private environment transport together with the recovery reference. The recovery process clears unrelated inheritance and reads only the allowed current values, retaining pane-generated routing identity. ProgramFiles(x86)-style names are persisted via private source-file lines, not literal -e arguments; the advertised v1 environment-file protocol retains its identifier grammar and uses a private supplement for these Windows names. Native set/unset session-environment APIs now accept their mixed-case/parenthesized names; POSIX validation remains unchanged. Caller respawn env objects are copied before recovery metadata is added.

Validation: four complete private/scoped/cleanup/stock files passed 19/19 with actual stock psmux enabled. Real scoped initial launch followed by external no-command respawn read updated allowed values while excluding unrelated inheritance; ProgramFiles(x86) update and unset survived subsequent raw respawn. Explicit scoped respawn followed by another external respawn also read its current successor value and preserved owned registry routing. Three additional environment/parent files passed 19 assertions with 20 platform skips, recorded as skips. Daemon typecheck passed. No active team/session or main deployment was modified. Creation-hook environment ordering, arbitrary Windows environment names beyond the supported transport grammar, real Herdr console attachment and full same-head acceptance remain open.

### Stock creation-hook environment timing — 2026-11-02

The direct argv executor now explicitly advertises support for per-invocation process environment. Stock native new-session passes application assignments through that environment before the server starts, keeping values off argv and avoiding global environment mutation or config replacement. Adapter-owned process routing, executable lookup, profile/config and terminal identity variables remain pinned to the daemon; the private child bootstrap still supplies the full selected child environment. Injected executors without the capability retain the prior private-bootstrap/post-create behavior rather than silently being assumed to support the new channel.

Real stock 3.4.0 acceptance used its session-created hook to spawn a witness process. The executor held the new-session reply until that witness existed, preventing the later source-file from supplying the observed value. Two different sessions observed their own application values, the first session retained its value, a personal status option remained effective, and personal config bytes remained unchanged. The executor also proved private Unicode/newline environment transport without parent mutation or value argv. Six complete targeted files produced 10 passed and four platform skips; daemon typecheck passed.

Limits: this receipt covers cold creation with an explicit owned personal config and a supported session-created hook. Warm-claim ordering, platform/control-variable hook equivalence, old injected executors and other hook events are not proved complete. The initial attempt using after-new-session was not fired by this stock build, and format-only observation was insufficient; neither is counted as passing. Full same-head native/Linux and desktop acceptance remain pending.

### Warm-claim creation witness — 2026-11-02

The creation-hook test now explicitly starts an owned empty standby, captures its native PID from the task registry, verifies no creation witness fired while it was empty, then confirms the first real session has that exact PID. Its hook receives the private application value before the adapter can run post-create source-file. A second configured session uses a different PID and observes its own value, with the first session and personal config preserved. The real stock test passed. This supersedes the earlier unproven cold classification of its first sample: without PID evidence that classification was too strong. The current sample proves held-warm claim plus a distinct cold sibling, not every pool/config combination.

The installed tarball gate now checks exact regular-file bytes for the native tile and following helpers and executes the installed following entry with no path, requiring its honest error. The strengthened heavy gate is pending execution on the committed source below.

### Installed native terminal assets gate passed — 2026-11-02

At exact 686b95403deee7d20a4ac280b93f32cadb13444e, the strengthened native GATE passed in 72 seconds (05:17:44–05:18:56 UTC). HEAD and tracked-diff SHA256 were identical before/after, with the tracked tree clean. The owned source build, tarball, isolated-prefix npm install, exact regular-file bytes of windows-tile-attach.ps1/follow-events.mjs, installed following helper invocation, SQLite ABI, installed context/spec operations and actual rig.cmd daemon-subpath load passed. Receipt: pack-terminal-assets-686b954.json in the task resource directory. No deployment or publication occurred. The protected untracked diagnostic remains outside a clean-release claim.

Third-party status check: https://www.superlogical.com/rex/docs/installation currently documents public testing for macOS and Linux/FreeBSD servers, while Windows server/client work is not yet included in public testing. Native Rex real acceptance therefore remains an external availability dependency, and its OpenRig native mapping is not declared implemented or accepted. This is distinct from Herdr, whose public Windows build exists but whose real psmux in-pane attachment remains unresolved.

### Recovery-loader process attribution regression fixed — 2026-11-02

The safe inventory follow-up found that native managed-parent attribution still recognized only the old one-time scoped loader after the recovery loader was added. It now shares a canonical loader recognizer with the generator: both old and recovery forms must round-trip exactly, retain an absolute owned staged-name path, and have one uniquely attributable later shell. Appended arbitrary PowerShell is rejected as a managed wrapper. No decoded source is evaluated by recognition. Three complete parent/scoped/cleanup files passed 16/16, including real stock scoped lifecycle execution with its opt-in enabled; daemon typecheck passed. This is newer source than the 686b954 installed gate.

### Git Bash native managed command delivery — 2026-11-02

Native command delivery now supports a qualified POSIX pane shell through the same private PowerShell loader used for cmd. It sends only the fixed loader and staged path, preserves the existing bounded input/guard path, and keeps the managed native command in the private consumed file. Real Git Bash adds one intermediate MSYS Bash fork before its native child: attribution permits exactly one later same-executable, identical-argv fork with one uniquely attributable managed bridge. Changed argv, competing children and a second fork are rejected. This is not a general descendant search.

A further regression surfaced when existing PowerShell fixtures used the production private bootstrap: idle-shell proof still expected a lone bare shell. It now recognizes the canonical wrapper and its unique later bare shell and requires the kernel console census to match those exact PIDs, rejecting the receiver once it starts. The old fixture executor no longer appends a second startup command; an owned config supplies its profile-free default shell, and cleanup ends its exact namespace standby as well as its sessions. Four failed-run scratch roots were separately reconciled as stopped and removed; main runtime and other namespaces were untouched.

Validation: five complete files passed 264/264 with stock psmux enabled: real Git Bash managed launch and exact runner attribution, cmd Pi/OMP/stub bridges, bounded MSYS ancestry, native PowerShell provider/idle/input/argv checks and the full 253-case lineage file. Daemon typecheck passed. Consumed launch/paste files were absent, the owned runner stopped with its test server, and wrong launch identity was refused. Other POSIX shell executables, arbitrary shell-language/alias semantics, legacy pane graphs and every idle/orphan combination are not declared accepted. Real Herdr attachment and overall parity remain incomplete.


### 2026-11-02: cancelled Pi/OMP launches retain prior runner state

Pi runtime launch and legacy Pi/OMP resume now publish the pending sidecar at the guarded native input boundary, after asynchronous preparation. A cancelled selection leaves the previous sidecar bytes unchanged; an authorized launch rereads the latest durable cursor before publishing pending. The native PowerShell receiver fixture verifies pending exists before dispatch.

Validation: Windows runtime adapter 75/75; legacy selection and native synthetic dispatch 8/8; WSL runtime adapter plus legacy selection 79/79; daemon TypeScript noEmit passed. Cancellation regressions previously failed 16 of 24 cases. These are scoped adapter checks, not real provider continuity or a complete current-head suite. No runtime deployment or push.


### 2026-11-02: same-head CLI/TUI comparison and root project watcher

At 6a724f2f835b3603b30cacf7e688b7a55cc386fa, complete CLI/TUI directory runs finished with stable source: Windows 7,514 passed, 25 failed, 115 pending (9m21s); WSL 7,461 passed, zero failed, 192 pending (4m22s). Windows failures: provider 20, kernel startup 3, MCP context pack 1, known terminal discovery 1. This is not a green native suite. The WSL mirror matched 4,693 public regular tracked files before and after; one private source file and six tracked symlinks were excluded from that proof. Different platform test totals and pending cases are not counted as equivalent acceptance. Receipts: cli-tui-comparison-6a724f2.json and its two report/metadata pairs in the task resource directory.

A subsequent source audit reproduced a shared root-project defect on both hosts: the watcher added an extra separator to filesystem roots and omitted a shallow policy watch when the project root was its own upper boundary. It now keeps the root separator and watches the root policy by exact filename, with recursive coverage still limited to missions. The new regression failed before the fix and passes afterward; the four complete proof watcher/policy/readiness files pass on both hosts, and daemon TypeScript noEmit passes. The mock filesystem fixture does not watch or modify a real system root. This newer daemon change is scoped validation, not a rerun of the complete suites or a deployment.


### 2026-11-03: provider fixture uses fetch-compatible owned ports

The Windows complete-run provider failures all targeted ephemeral port 6566. An independent owned loopback listener reproduced Node fetch rejection with cause bad port, before any HTTP request could reach that listener. Windows can assign such low ports for listen(0), even when the fetch guard correctly registers the owned origin. The provider fixture now binds a random high port on explicit loopback, with at most 16 retries for busy/reserved ports and exact-origin registration. Production connection behavior and the fetch guard are unchanged. Regression coverage checks a real fetch, retry cleanup for busy/access-denied ports, and the finite retry limit. The complete provider and helper files pass on Windows and WSL.

The earlier MCP/provider/kernel three-file follow-up passed 62/62, but does not replace the complete-run 25-failure result. The port evidence explains the provider sample; MCP and kernel full-run failures remain unclassified, and the previously bounded terminal discovery investigation is not reopened. No complete suite rerun, real provider invocation, runtime deployment or push is claimed by this fixture change.

The final provider/helper verification retains the existing unbound-server and unrelated-target refusal regressions alongside the new allocator cases: 38/38 passed on Windows and WSL. These replace the intermediate 36-case helper receipts for this scoped change.


### 2026-11-03: MCP and kernel fixture listener follow-up

The MCP operation and kernel-start evidence fixtures now use the same bounded high-port owned listener as the provider fixture. MCP still uses the real Hono Node adapter and daemon routes; kernel retains its real waiter, HTTP path and existing 100ms fixture deadline. Failure assertions now include the owned endpoint and received observations so a later complete-run failure can distinguish missing HTTP delivery from returned kernel state. Three complete helper/MCP/kernel files pass on Windows and WSL with two workers.

This removes the same low-port allocation risk, but the old MCP and kernel failures lack enough detail to attribute their causes retrospectively. Their complete-run status remains unresolved until fresh evidence; no timeout increase, production change or broad acceptance claim is made.


### 2026-11-03: complete native CLI/TUI follow-up and UNC resume validation

At clean tracked source 99677854999966ddba8836532b8dbd4af3a6adf6, the complete Windows CLI/TUI run finished in 9m10s: 7,542 passed, one failed, 115 pending. HEAD and tracked diff were unchanged. Provider, MCP and kernel failures from the prior complete run did not recur after the owned-listener changes. The one remaining failure is the previously bounded Windows Terminal discovery fixture; no additional same-path trial or readiness claim is made. Receipt: workspace-cli-tui-9967785-metadata.json and its JSON report. The last complete WSL run remains the earlier 6a724f2 public mirror; newer scoped passes are not a current-head full WSL claim.

The subsequent path audit found Pi/OMP resume-token validation treated Unicode/space UNC paths differently for forward, backslash and mixed separators. It also admitted a forward-slash device alias that the backslash form rejected. Windows UNC recognition now accepts the equivalent separator forms and rejects device aliases through either separator. Raw traversal and alternate-stream refusal and token redaction remain. Four new cases failed before the repair; complete format tests pass on Windows and WSL, and daemon TypeScript noEmit passes. These are synthetic format checks and do not access an actual SMB share or establish provider continuity.

A separate owned-directory capability probe could not enable Windows per-directory case sensitivity: fsutil returned Access is denied. Its exact scratch directory was removed, with no elevation or retry. Thus actual case-sensitive-directory viewer attribution remains host-unverified, not accepted. Receipt: viewer-case-sensitive-20261103.json. The owned remote SSH endpoint also remained unreachable before authentication; no real remote native-command pass is added.


### 2026-11-03: renewed native installed-package gate

At exact c96371a3ed069ac3258ad4e5843edb9796952d4f, the native target GATE passed in 70 seconds (16:15:28-16:16:38 UTC on 2026-11-02). Source HEAD and tracked-diff SHA256 matched before and after, with the tracked tree clean. The real source build, tarball, isolated-prefix npm installation, SQLite ABI, installed context/spec resource operations, exact native terminal helper files and installed following entry behavior, and rig.cmd daemon-subpath load passed. Node test result: one gate passed, zero failures and zero skips. Receipt: pack-terminal-assets-c96371a.json and its log in the task resource directory.

This is installed-package acceptance for that source, not publication, actual deployment replacement, full daemon-suite acceptance, GUI qualification, remote SSH continuity or a clean-release claim over protected untracked material.


### 2026-11-03: native host posture applicability is explicit

The product-factory-vps profile is a POSIX VPS baseline (id, sshd -T, UFW and ss). A registry entry explicitly selecting PowerShell previously ran those commands anyway and could turn missing POSIX tools into false account/firewall failures. Such entries now receive all nine checks as unknown with Windows-native assessment guidance, without dispatching shell commands or public-address probes for an inapplicable profile. Absent/POSIX remote-shell selection retains the existing profile behavior. The new regression failed before the change; the complete host file passes on Windows and WSL, and CLI TypeScript noEmit passes.

This is a diagnostic correction, not implementation or acceptance of an equivalent Windows security-posture baseline. Windows account/administrator, effective OpenSSH policy, firewall ingress and listener checks remain an explicit implementation/qualification gap. The broader parity goal is incomplete.

### 2026-11-03: explicit Windows host posture collector and CLI entry

`rig host doctor windows-test --posture product-factory-windows --json` now
selects a separate native baseline for an SSH registry entry with
`remoteShell: powershell`. The original `product-factory-vps` remains POSIX.
The registry's paired `rigPath` is still required by the ordinary doctor legs.
No remote OS is inferred from the caller's OS.

The fixed read-only collector reports nine checks: an enabled non-administrator
local `openrig` account, default OpenSSH administrator denial and authentication
settings, effective Windows Firewall profile defaults, an explicit Tailscale
interface Allow rule, Tailscale trust settings, standard-port daemon listener
addresses, and two optional outside-vantage TCP observations. The native account
census uses the Administrators SID; unresolved nested groups stay unknown.
Firewall defaults come from ActiveStore and require all three profiles; missing
or NotConfigured actions stay unknown. A rule's presence is distinguished in its
detail from actual port reachability. Listener addresses use IP validation and
the loopback/CGNAT ranges. Failed public dials retain their refusal/filter/timeout
scope rather than proving a specific firewall configuration.

Microsoft documents Windows OpenSSH administrator restrictions through
[DenyGroups](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh-server-configuration)
and the effective firewall policy store through
[ActiveStore](https://learn.microsoft.com/en-us/powershell/module/netsecurity/get-netfirewallprofile).
This collector reads only a bare executable from the registered sshd service;
alternate service arguments/config files and unavailable settings stay unknown.
Its SSH rows describe default service-wide settings, not all Match/user-specific
overrides. Exact literal administrator-group denial is recognized; ambiguous
group patterns remain unknown. Authentication observations require public-key
support and disabled password, keyboard-interactive, GSSAPI and hostbased methods.
No policy, account, service or credential is modified.

The collector travels as trusted shipped script bytes over SSH stdin behind a
small fixed encoded bootstrap. This avoids nesting the whole script in Windows
command-line limits; the complete native SSH command is tested below 8191
characters. Direct PowerShell `-Command -` failed to execute this compound stdin
script; the fixed bootstrap reads the complete stdin and then executes it as one
script. That failed experiment is not counted as acceptance. No keys, raw sshd
configuration, user SIDs or Tailscale account data are returned by the collector.

Validation: complete host and Windows-posture files pass 50/50 on Windows and
49/49 with one Windows-only real-process skip on WSL. CLI TypeScript noEmit
passes. The ordinary CLI/registry path, malformed/oversized/versioned data,
ambiguous facts, insecure observations and outside-probe outcomes are covered.
The Windows test executes the actual read-only collector through both production
PowerShell launch layers and stdin under owned Job custody, replacing only SSH
network transport. Independent local stdin collection completed with one pass,
one baseline failure and five unknowns; that is observed host state, not a green
hardening verdict. Receipts: windows-posture-native-qualified-20261103.json,
windows-posture-wsl-qualified-20261103.json and native-posture-stdin-local-r2-20261103.json.

Real remote Windows SSH acceptance remains blocked by the existing endpoint's
pre-authentication timeout. Full Match/custom-service qualification, indirect
group resolution, effective rule-overlap/port access, nonstandard daemon-port
selection and a complete same-head suite/installed-package rerun remain open.
This implementation does not close the overall parity goal or authorize changes
to the actual host's security configuration.

### 2026-11-03: service arguments and effective SSH Match contexts

The native posture collector now decodes the registered sshd service command
with the existing Windows argv parser, exposed through the paired daemon launch
surface. The pure parser runs under the already-required Node executable with
service data over stdin. It has a five-second child bound, uses UTF-8/BOM-aware
base64 framing and avoids an Add-Type/compiler dependency. A real fixture
exposed both PowerShell 5.1 JSON array wrapping and BOM corruption; neither is
hidden by a successful independent source-only sample.

Recognized configuration options (including an absolute `-f`, `-o` and `-p`)
are retained, runtime flags removed, and `-E` consumed without creating the
service log. Option case matters: `-e` and `-E` are distinct. Unknown switches,
missing values and relative configuration paths remain unqualified. The query
does not launch an SSH listener or replace the actual Windows service.

The first sshd query now includes a complete connection tuple from SSH_CONNECTION
and the intended user, using [sshd extended test mode](https://man.openbsd.org/sshd.8).
A context-free preliminary `-T` read was rejected by the real Windows build for
Match LocalPort and is no longer used. The dedicated openrig authentication
context and built-in Administrator SID account context are queried separately.
Missing connection data and UseDNS-enabled host resolution remain unknown.
Global settings alone no longer qualify either SSH row. Ambiguous DenyGroups
patterns are also unknown. Explicit public-key-only
[AuthenticationMethods](https://man.openbsd.org/sshd_config#AuthenticationMethods)
can establish that policy without inventing unreported build-specific methods;
an observed password alternative under `any` fails even if another method is
unreported. Other incomplete method combinations remain unknown.

Validation: complete host/native-posture files plus the opted-in real sshd query
fixture passed 56/56 on Windows. WSL passed 54 with two native-process skips,
recorded separately. The fixture uses owned OpenSSH binaries, generated owned
host keys, synthetic service/account inventory and the actual sshd `-T -C`
program. Two user/port contexts change the authentication/administrator verdicts;
unknown arguments, relative config, missing context and DNS-dependent context
stay unknown. The same real fixture additionally passed with spaces, # and
Unicode in the configuration filename. Its exact files/keys were removed and
the requested service log was never created. No live service, remote host or
operator key was used. Daemon build and CLI typecheck passed. Receipts:
posture-context-native-final-20261103.json, posture-context-wsl-final-20261103.json
and posture-context-native-unicode-20261103.json.

The installed-package gate now loads `host doctor --help` from the installed
entry and requires the Windows profile, covering its paired parser import.
Execution of that strengthened gate is pending on the committed source. Real
remote SSH authentication, all user/group/host combinations, DNS-based matches,
custom service working directories and full same-head suites remain unaccepted.

The strengthened native installed-package GATE subsequently passed at exact
c10a79be943cee17362b63e01d653dbc0d9bdabc in 68 seconds (17:00:49-17:01:57 UTC,
2026-11-02). HEAD and clean tracked-diff hash matched before/after. In addition
to the earlier build/tarball/isolated-prefix install, helper/resource/SQLite and
rig.cmd checks, the installed `host doctor --help` loaded the new Windows posture
module and its paired parser export. Receipt: pack-terminal-assets-c10a79b.json
and its log. This is package loading acceptance, not remote-host or complete
same-head test acceptance; no publication or deployment occurred.

### 2026-11-03: explicit posture target ports and unknown observer failures

Both posture profiles now accept explicit target ports, independently of the
caller's daemon environment. For example, from a build containing this change:

```sh
rig host doctor windows-test --posture product-factory-windows --daemon-port 17433 --ssh-port 2222 --json
```

The defaults remain daemon 7433 and public SSH probe 22. The registered SSH
alias/config still selects the SSH transport; these flags select posture
observations. Ports must be integers from 1 through 65535. Malformed ports and
port flags without a posture profile are rejected before doctor/SSH/HTTP/TCP
probes. POSIX listener parsing and outside probes use the selected ports. The
native collector queries the selected daemon port and returns its numeric port
with the observation; a response for another port cannot certify the selected
listener. Missing or mismatched port evidence remains unknown.

The audit also found that POSIX outside probes treated unknown as pass, while
the default TCP observer treated local permission/DNS errors as closed. Both
now preserve unknown. A DNS timeout before a peer address is known is also
unknown. An observed connection is open; a network refusal/unreachability or
post-resolution timeout retains its limited failed-dial scope. Owned sockets
are destroyed on every terminal observation, including an unclassified close.
These observations do not identify a particular firewall rule or certify every
network vantage.

Three targeted regressions failed before this change and passed afterward
(55 other tests were filtered in that red/green run). Final complete scoped
host/native-posture files, with the owned real sshd fixture enabled, passed
87/87 on Windows. WSL passed 85 with two native-process skips. CLI typecheck
passed. A real owned loopback listener was reached by the default TCP observer
and then identified through both production PowerShell launch layers and the
actual Get-NetTCPConnection collector at its nondefault port. The same returned
facts stayed unknown for another requested port. No actual daemon or team was
used or restarted. CLI validation, neighboring decimal-port prefixes, observer
permissions, DNS failure/timeout and socket cleanup are covered. Receipts:
posture-ports-before-20261103.json, posture-ports-after-20261103.json,
posture-ports-native-dns-qualified-20261103.json and
posture-ports-wsl-dns-qualified-20261103.json.

The installed gate now requires both port options in installed host doctor
help. That updated gate and complete current-head suites remain pending; the
earlier c10a79b installed receipt does not cover these newer changes. Real
remote outside-vantage acceptance remains unverified while the owned SSH
endpoint is unreachable. No security policy, publication or deployment changed.

### Viewer foreground shell argument preservation (2026-11-03)

An owned receiver reproduced two independent gaps: Windows PowerShell 5's
native call operator dropped empty arguments and changed embedded quotes;
the viewer rejected a sole foreground cmd.exe shell outright. Generic native
viewer argv now uses the existing ProcessStartInfo argument bridge, with the
observed shell's working directory and child exit status preserved. Cmd uses
a fixed PowerShell encoded-command bootstrap, keeping percent expansion,
delayed expansion and command operators out of argument data. Exact canonical
tile wrappers keep their existing compact encoding. Cmd input longer than
8190 characters is refused before dispatch; long-command staging is still a
gap. The sole-foreground-shell identity guard remains required.

Real owned PowerShell and cmd processes both preserved empty strings, quotes,
trailing backslashes, Unicode, newline and expansion/operator literals, cwd and
exit status 7. Six related files passed 35/35 on Windows; WSL passed 27 with
eight native-only skips. Daemon TypeScript checking passed. Receipts:
viewer-argv-before-20261103.json, viewer-argv-after-20261103.json,
viewer-native-qualified-20261103.json and viewer-wsl-qualified-20261103.json.
These process fixtures do not qualify actual Herdr foreground attribution,
in-pane attachment or GUI reattachment. Those earlier acceptance gaps remain.
No deployment, team restart or public push was performed.

### Quoted native Herdr PATH entries (2026-11-03)

An owned filesystem fixture reproduced failure to discover herdr.exe in a
double-quoted absolute Windows PATH directory containing spaces and Unicode.
The resolver now removes the matching surrounding quotes before its existing
absolute-directory and regular-file checks. Relative PATH entries remain
refused; no shell lookup or batch shim execution was added. The regression and
related viewer tests passed on Windows (herdr-path-before-20261103.json and
herdr-path-after-20261103.json). This qualifies discovery only, not actual
Herdr GUI attachment. No installed application or runtime was changed.

### Installed native gate at 3952477 (2026-11-03)

The target-native installed-package gate passed at exact source commit
39524779d75901f18e968ee9ee0021716b03abc5, with clean tracked source before
and after (2026-11-02 17:45:13 through 17:46:22 UTC). This includes the newer
host-doctor port options and viewer shell/PATH fixes in the source build and
tarball. The gate built, packed and installed into an isolated prefix, checked
terminal helper bytes/execution, native SQLite ABI, installed resource/file
operations and the rig.cmd daemon-subpath load. Receipt:
pack-terminal-assets-3952477.json and its log. No global installation,
deployment or publication was performed. Installed gate success does not
establish real Herdr GUI attachment or full engine parity.

The latest scoped WSL viewer run passed 27 tests with nine native-only skips
(viewer-wsl-3952477-20261103.json). The additional skip is the real Windows
quoted-PATH filesystem regression; Windows passed it. Complete current-head
Windows/WSL suites remain outstanding.

### Complete CLI/TUI comparison at e998266 (2026-11-03)

Both complete directory runs used source e998266b9bd9dd13a31f73099eb51fcdda6dbba2.
Windows finished with 7,601 passed, two failed and 116 pending (7,719 total),
with clean tracked source before and after. WSL finished with 7,523 passed,
one failed and 194 pending (7,718 total); all 4,698 public regular files
matched the snapshot before and after. One private file and six symlinks
were excluded from that mirror verification. Runtime versions remain different
(Windows Node 24.14.1, WSL Node 24.11.0).

Windows still failed the known owned-PATH Windows Terminal discovery case;
its bounded investigation is not reopened by this run. Both platforms also
failed different live-events.test.ts wait conditions. The WSL complete run
failed the oversized-empty-data-fields case, while a separate unchanged-source
run passed that entire file 17/17. This does not clear the full-run failure.
Windows failed the first real HTTP SSE delivery case. Its exact fixture port
and failed wait phase were not captured, so neither a bad-port explanation nor
a product parser defect is established. These results are not green parity.
Receipts: workspace-cli-tui-e998266-metadata.json, cli-tui-wsl-e998266-metadata.json,
their full reports. The unchanged-source scoped pass was observed before the
fixture changes below; its fixed-name report was subsequently overwritten and
must not be used as an immutable source-bound receipt.

### Recovery attach guidance quoting (2026-11-03)

An actual PowerShell argument-witness function reproduced split session names
containing spaces and a parse failure for names containing an apostrophe. The
shared attach-guidance renderer now quotes the session word and uses native
PowerShell apostrophe escaping on Windows, retaining POSIX escaping elsewhere.
The same rule applies to server argument values. Ordinary safe names keep
their existing command spelling.

Actual platform-shell witnesses plus existing server tests passed 10/10 on
Windows and 10/10 on WSL; daemon TypeScript checking passed. Receipts:
attach-guidance-e998266-before.json, attach-guidance-before-20261103.json,
attach-guidance-native-after-20261103.json and attach-guidance-wsl-after-20261103.json.
The witnesses exercise shell parsing into function arguments, not native
psmux argument parsing or a real session attachment. Cmd guidance, arbitrary
native quote-bearing session names and the existing stock-pipe-name limitation
are not qualified by these tests. No existing session, daemon or team changed.

### SSE fixture observations and monotonic deadlines (2026-11-03)

The live-events HTTP fixtures now use the already-qualified bounded high-port
listener rather than port zero, avoiding fetch's forbidden-port range. This is
a fixture correction based on the earlier proven low-port problem, not proof
that either e998266 SSE failure had that cause. Wait deadlines use monotonic
performance.now instead of wall-clock Date.now without increasing their limits.
The failed HTTP notification and oversized-frame phases now report their
specific phase and observed connection/open/event state; HTTP failures also
include the exact owned endpoint and opening errors. Bind failures reject the
fixture setup instead of leaving its promise pending.

The complete live-events file passed 17/17 on each platform after these fixture
changes (live-events-native-observed-final-20261103.json and
live-events-wsl-observed-final-20261103.json). Product SSE parsing/reconnect
code was not changed. A future complete run must still establish whether the
earlier full-run failures recur; these scoped passes do not replace them.

### Recovery guidance across the native argv boundary (2026-11-03)

The previous shell-function witnesses did not establish what a native child
receives. A new owned Node receiver, launched through an actual Windows Job
and PowerShell 5, reproduced alteration of a double-quote-bearing session
argument; space and apostrophe cases already passed. The guidance renderer
now uses the existing native argv bridge for empty or double-quote-bearing
words. Other hints retain readable platform-shell quoting. Callers can supply
an explicit executable argv prefix; existing callers retain tmux by default.
NUL-bearing argv and missing executable prefixes are rejected before rendering.

Four related files passed 19/19 on Windows. WSL passed 14 with five native-only
skips; daemon TypeScript checking passed. Receipts:
attach-native-argv-before-20261103.json, attach-native-argv-after-20261103.json
and attach-native-argv-wsl-after-20261103.json. The receiver proves child argv
and exit status 7 without starting tmux or touching any existing sessions. It
does not establish stock psmux's support for every session-name character,
actual attachment, or cmd recovery-guidance parsing. Those remain unqualified.

### Exact recovery attachment names (2026-11-03)

Recovery attachment hints previously passed a bare session name. An independent
owned tmux 3.4 server containing only owned-neighbor confirmed that has-session
accepts the missing bare name owned by prefix, while =owned fails and
=owned-neighbor succeeds. The shared guidance renderer now passes =<name>,
matching the CLI's existing exact-name attachment behavior. Inventory, recovery
actions, CMUX layout and session-route expectations were updated to preserve
that target. The temporary server and its directory were removed.

Windows passed 262 tests in the initial seven-file validation and 99 in the
final CMUX/session-route recheck; WSL's combined eleven-file run passed 393 with
four native-only skips. Daemon TypeScript checking passed. Receipts:
attach-exact-native-after-20261103.json, attach-exact-callers-final-20261103.json,
attach-exact-wsl-final-20261103.json and tmux-exact-target-oracle-20261103.json.
The inventory MCP shell-parser test now uses actual PowerShell on Windows
instead of unconditionally spawning /bin/sh; it remains a shell-function
witness, not native Claude argv or provider acceptance.

The target oracle uses has-session's session-target semantics. An earlier
display-message attempt was not a valid oracle for that grammar and did not
establish an attach result. No GUI attachment or stock psmux prefix behavior
was qualified by the Linux oracle. Exact naming also does not close the
existing concurrent same-name replacement/PID atomicity gap.

### Literal recovery working directories (2026-11-03)

Claude and Codex inventory recovery guidance previously interpolated cwd into
an unquoted cd command. Two real PowerShell regressions reproduced parse
failures for owned directories containing spaces, brackets, an apostrophe and
Unicode. Windows guidance now uses Set-Location -LiteralPath with PowerShell
literal quoting; POSIX guidance uses a quoted cd operand.

The tests create both the intended bracket-bearing directory and a similarly
named decoy, execute the served command in the actual platform shell, and
compare filesystem identities. Both runtimes select the intended directory.
The full inventory file passed 73/73 on Windows and 73/73 on WSL; daemon
TypeScript checking passed. Receipts: recovery-cwd-before-20261103.json,
recovery-cwd-native-final-20261103.json and recovery-cwd-wsl-final-20261103.json.
Owned fixture directories were removed. No provider, existing session or main
runtime was launched or changed. Provider recovery argv, including native
PowerShell handling of inline MCP JSON, remains a separate unqualified scope;
the shell-function witnesses above do not prove that native boundary.

### Provider recovery argv and npm resolution (2026-11-03)

A real Node receiver reproduced loss of the double quotes in Claude's inline
MCP JSON when PowerShell 5 forwarded a served recovery command. Inventory
presentation now wraps quote-bearing or empty provider words in a data-only
recovery bridge. Ordinary safe hints and POSIX commands keep their current
form; managed launch builders are unchanged.

At execution time a finite Node helper uses the existing Windows provider
resolver to select a native executable or a recognized npm installation from
the invoking environment. It emits the existing ProcessStartInfo launcher as
base64 UTF-16, avoiding console-codepage corruption of Unicode paths. The
PowerShell caller launches the resolved argv with inherited console handles
and the current literal working directory, then preserves the provider exit
status. Missing providers fail explicitly instead of falling back to a shell
alias/function. This helper does not start a daemon or inspect credentials.

Owned npm fixtures executed all served Claude recovery variants and Codex
profile recovery variants through actual PowerShell and Node. Inline MCP JSON,
an apostrophe-bearing Codex profile, names and exit status 7 were preserved;
missing-provider cases launched no receiver. The complete inventory file
passed 75/75 on Windows and 73 with two native-only skips on WSL; daemon
TypeScript checking passed. Receipts: recovery-provider-before-20261103.json,
recovery-provider-native-final-20261103.json and recovery-provider-wsl-final-20261103.json.
Fixture files were removed. These are native argv and npm-resolution proofs,
not authenticated provider continuity or interactive console qualification.
Custom non-npm script launchers, cmd guidance and cross-host copying of local
helper paths remain unqualified. The installed gate now checks the new helper
bytes and paired-module loading; that updated gate has not yet run.

### Installed recovery bridge gate at 176f9cd (2026-11-03)

The updated target-native package gate passed at
176f9cd0247c463187a42405dd58003fee173309 with clean tracked source before
and after, from 2026-11-02 18:18:41 through 18:19:52 UTC. It built and packed
the current source, installed into an isolated prefix, compared the delivered
provider recovery helper bytes with source and executed that helper to prove
its paired launcher imports load before missing data is rejected. Existing
native ABI, file/resource, terminal helper and rig.cmd load checks also passed.
Receipt: pack-terminal-assets-176f9cd.json and its log.

This installed check proves delivery and loading, alongside the source-side
owned npm argv tests above. It does not execute a real authenticated provider,
qualify interactive console continuity, or replace current-head complete
Windows/WSL suites. No global install, runtime deployment, team restart,
publication or public push was performed.

### Quoted provider switch undo and list guidance (2026-11-03)

The Codex provider switch receipt interpolated its home directly into the undo
command, and a missing-profile refusal did the same in its list command.
Actual platform-shell witnesses reproduced failure for homes containing spaces,
an apostrophe and Unicode. Both commands now quote their data words for POSIX
or native PowerShell; ordinary safe hints keep their prior form. The regression
uses an in-memory login service and shell argument witnesses, not real logins.

The related Windows file-level switch tests initially failed because their
fixtures used POSIX mode bits without establishing private Windows DACLs.
They now use the existing private directory/file constructors. The production
auth checks were not weakened. The two complete files passed 22/22 on Windows
and 22/22 on WSL, including synthetic login save/switch/undo, retained recovery
copies and serialized same-home switches. Daemon TypeScript checking passed.
Receipts: provider-undo-home-before-20261103.json,
provider-undo-home-native-after-20261103.json,
provider-undo-home-native-final-20261103.json and
provider-undo-home-wsl-final-20261103.json. Synthetic fixture roots were removed;
no personal credential file or existing seat was read, switched or restarted.

The resume-metadata refresh probe was also inspected: its Windows branch
already resolves the provider and uses renderWindowsLaunch, so it was not
replaced with the presentation wrapper. Manual in-place restart recovery and
other human-facing command surfaces still require separate coverage.

### Pinned Windows in-place manual recovery (2026-11-03)

An in-place restart previously returned its bare resume core as manual recovery
guidance, omitting the observed executable, cwd and Codex home. For a process
observed as native Windows, preflight now prepares a structured PowerShell
recovery command using that executable path, exact resume argv, working
directory and the observed CODEX_HOME plus HOME when available. It does not
copy the full managed seat environment or resolve a new provider from PATH.
Missing executable/path evidence refuses before stopping. All failure returns,
including a thrown stop operation, retain the prepared recovery command.
The actual managed restart launch remains unchanged.

An owned Node receiver executed the command through real PowerShell with an
unrelated PATH and ambient homes. It received the intended argv (including
quoted reasoning-effort data), CODEX_HOME, HOME, cwd and exit status 7. Service
fixtures also check exception-return metadata and refusal before effects when
the executable was not observed. The two complete files passed 158 with one
pre-existing skip on Windows, and 157 with two skips on WSL; daemon TypeScript
checking passed. Receipts: pinned-recovery-native-home-final-20261103.json and
pinned-recovery-wsl-home-final-20261103.json. Skips remain unverified coverage.
Owned receiver files/directories were removed. No real provider, seat, daemon
or team was stopped or restarted. Executable path pinning is not a file-hash
or atomic replacement guarantee, and these fixtures do not qualify interactive
console behavior or authenticated provider continuity.

### Guidance-path interpolation review and remote auth check (2026-11-03)

A new public-only scan at daa70f5 inspected 1,516 production JS/TS files after
excluding the one private file before content reads. Its selected literal
cd/home/file/dir/path interpolation pattern yielded 19 lines in 12 files.
Every selected candidate was reviewed: one remote-auth check instruction
needed quoting; the others were diagnostics, directory-created itemization
markers, already quoted operands, existing fixes, or the structured native
Compose path. The Compose production startup supplies execArgvCommand on
Windows; this inspection is not real Docker/Podman engine qualification.
Inventory and dispositions: guidance-paths-daa70f5-20261103.json and
guidance-path-review-daa70f5-20261103.json. This narrow pattern is not an
exhaustive command-surface or parity audit.

When a remote rig auth switch loses its connection, its unknown-outcome check
now quotes the host and Codex home for the invoking platform shell. Actual
PowerShell and /bin/sh witnesses preserve a remote home containing spaces,
an apostrophe and Unicode. The SSH runner is injected, and the test confirms
exactly one attempted operation with no automatic check or retry. No real
SSH connection or credential switch was performed. The two complete CLI files
passed 20/20 on Windows and 20/20 on WSL; daemon build and CLI TypeScript
checking passed. Receipts: auth-host-check-before-20261103.json,
auth-host-check-native-final-20261103.json and auth-host-check-wsl-final-20261103.json.

The shared guidance-word function is exposed through the existing paired
windows-launch package surface. The scoped WSL run copied its matching public
compiled surface and quote module; it is not a fresh complete-source WSL build.
These witnesses prove shell parsing, not arbitrary native shim behavior for
every quote-bearing remote POSIX filename. The installed package gate at
176f9cd predates this additional export/import and does not qualify this change.

### Installed paired import gate at d118cf5 (2026-11-03)

The target-native installed gate passed at
d118cf56a2a46b44486958c502878ed80becdd84 with clean tracked source before
and after, 2026-11-02 18:36:45 through 18:37:51 UTC. Current source built,
packed and installed into an isolated prefix; CLI loading includes the new
auth guidance import through the paired windows-launch surface. Provider
recovery helper delivery/loading and the existing native ABI, resource, file,
terminal-helper and rig.cmd checks passed. Receipt:
pack-terminal-assets-d118cf5.json and its log. This is package delivery/loading
evidence, not full current-head suites or real authenticated provider/engine
acceptance. No actual runtime installation, deployment or public push occurred.

### Complete CLI/TUI/UI comparison at 0aa6375 (2026-11-03)

Both selected directory runs used source
0aa63755a2fc991ba170ba730ac076d1fa62a325. Windows finished with 9,440 passed,
one failed and 116 pending (9,557 total), with clean tracked source before and
after. WSL finished with 9,362 passed, zero failed and 194 pending (9,556 total).
UI passed 1,837/1,837 on each platform. TUI passed 1,232 with 19 skips on Windows
and 1,237 with 14 skips on WSL. CLI passed 6,371, failed one and skipped 97 on
Windows; WSL CLI passed 6,288 with 180 skips. Skips are retained as unverified
coverage, not converted into passes.

The sole Windows failure is still terminal-window-windows.test.ts's owned-PATH
Windows Terminal discovery case; its bounded investigation remains exhausted.
Neither platform reproduced the earlier live-events failures in this complete
run. That observation does not establish their original cause. These selections
exclude the daemon suite and opt-in real provider/psmux acceptance. UI uses its
jsdom project configuration, not a real visible desktop window.

WSL's paired daemon was rebuilt before testing. All 4,703 public regular files
matched the frozen snapshot before and after. A first public-only build lacked
the deliberately excluded dependency and failed; that is retained as a coverage
setup result, not a platform defect. The existing excluded file stayed in its
original location. Its Git-normalized content identity matched the current
index before/after compilation and after the complete suite, without displaying
or copying its source. A raw-byte comparison had differed and was not a valid
comparison to the normalized indexed blob. Six symlinks remain outside snapshot
verification. Windows used Node 24.14.1 and WSL used Node 24.11.0, so these are
same-OpenRig-source functional checks, not identical-runtime performance tests.

Receipts: workspaces-comparison-0aa6375.json,
workspace-cli-tui-0aa6375-metadata.json,
cli-tui-ui-wsl-0aa6375-verified-metadata.json,
daemon-build-wsl-verified-0aa6375.json and
private-version-post-suite-0aa6375.json, plus the immutable full reports.
This result does not close the Windows discovery failure, daemon-suite or real
engine/provider requirements. No deployment or public push occurred.

### Portable Podman prerequisite and unchanged OpenShell boundary (2026-11-03)

The official [OpenShell v0.1.6 release](https://github.com/NVIDIA/OpenShell/releases/tag/v0.1.6)
still has no Windows asset, and the Windows branch remains at
e451bb390a3b463724ccf5547b46b9432428690d. No changed upstream fact justified
repeating the earlier failed native builds.

The official [Podman v6.1.4 release](https://github.com/containers/podman/releases/tag/v6.1.4)
does provide a portable Windows amd64 archive. A task-owned copy was downloaded,
its 32,122,424 bytes and official SHA-256 digest verified, and archive destinations
checked before extraction. Its native CLI returned podman version 6.1.4 through
owned Windows Job custody. Machine-init help also loaded. Local receipts are
under podman-native-6.1.4-20261103 (download-receipt.json, extract-receipt.json,
version-receipt.json and machine-help-receipt.json).

This is a portable CLI prerequisite only. No global installation, Podman machine
initialization/start, image execution or real OpenShell/Podman lifecycle was
performed. Help exposes host-default mounts; any subsequent owned machine test
must use task-local Windows config/data locations and explicit task volumes,
preserving existing engines and running WSL work. Engine acceptance remains open.

### Real scoped Podman observer acceptance and API negotiation (2026-11-03)

The subsequent task-owned rootless Podman 6.1.4 machine test supersedes the
prerequisite-only result above. Its private configuration/data directory and
explicit workspace mount were isolated from existing engines. The official
Windows SSH proxy exposed one task-specific named pipe; its default Docker-pipe
route was omitted. The selected engine reported Linux, rootless operation and
the non-root guest user's UID mapping.

The real server exposed an implementation defect hidden by the former fixture:
unversioned `/libpod/info` returned HTTP 404 with a plain-text body, while
`/v6.1.4/libpod/info` returned HTTP 200. The observer now discovers the Libpod API
version from the explicit Podman Engine component of `/version`, independently
of the Docker compatibility ApiVersion. It validates the numeric version before
forming paths and repeats discovery rather than retaining a version across
endpoint replacement. Non-success response bodies no longer mask their HTTP
status with a JSON parse error. Docker-only and malformed advertisements fail
before inventory; existing endpoint ownership and rootless identity checks stay
in force.

Native Windows passed all four observer regressions; the same two changed source
and test files passed three on WSL with one Windows-only case skipped. The daemon
TypeScript build passed. Regression HTTP servers accept only versioned Libpod
routes and deliberately return plain-text 404 responses for absent volumes.

Real acceptance then pulled the official hello image, ran its rootless container,
created two explicitly labeled test containers with three dedicated volumes,
and exercised the compiled default OpenRig observer. Exact capture and presence
passed; deleting those exact resources and observing their absence also passed.
Containers, volumes and the pulled image were removed; the owned proxy exited,
its pipe disappeared and the owned machine stopped. The default Docker pipe
remained absent throughout. The registered stopped machine and its private data
remain available for this ongoing acceptance task.

Receipts: podman-native-6.1.4-20261103/owned-version-r2-acceptance.json
(API discovery), owned-observer-fixed-acceptance.json (the acceptance harness's
overly strict image-ID-format check), and owned-observer-final-acceptance.json
(all four real acceptance stages passed). The harness accepted Podman's actual
bare hexadecimal image ID on the final run; that was not a product change.
An earlier version-probe receipt-name collision and missing pipe-readiness wait
were harness failures; their proxy was terminated and scoped state reconciled.

These are real Podman engine and observer checks using synthetic OpenShell
labels. They do not qualify an actual OpenShell CLI lifecycle, real provider
continuity, the entire daemon suite or every Windows/Linux behavior. No running
OpenRig deployment, original team, global installation or public push changed.

### Long cmd viewer argv uses private one-shot staging (2026-11-03)

The previous 8,190-character cmd viewer refusal is now covered by a staged
launch path in both native tile provisioning and the following explanation
strip. When the encoded command exceeds cmd's input limit, the already
attributed viewer directory receives a randomly named, exclusively created
private script. A bounded encoded bootstrap loads that script, removes its
literal path before starting the child, then preserves the existing native
argv bridge, observed cwd and child exit status. The foreground-shell identity
guard executes before staging. A caller without an owned absolute staging
directory still refuses; an unrepresentably long staging path refuses before
writing. No uncertain pane-run result is retried. A not-yet-consumed script
remains private in the original viewer attribution directory rather than being
deleted while a delayed receiver might still need it.

A real cmd process received a 10,000-character argument together with empty,
quote, newline, expansion/operator and Unicode data unchanged, retained cwd,
and returned exit status 7. Its dispatch command stayed below cmd's limit and
the one-shot script was absent afterward. All six complete viewer/follow files
passed 68/68 on Windows. WSL passed 61 with seven native-only skips after the
four changed implementation/test files were copied and byte-compared. The
daemon TypeScript build and whitespace check passed. This qualifies the native
shell launch path, not the still-unconfirmed real Herdr GUI/foreground attach
matrix, and does not raise Windows CreateProcess's own argv-size limit.

### Installed current helpers and quoted Rex PATH discovery (2026-11-03)

The complete native installed-package gate passed at clean source
dfaff96348b58b664147db886fbd8da2bd45077e in 71 seconds. Before/after HEAD and
tracked-diff hashes matched. This includes source build, tarball assembly,
isolated-prefix installation, exact installed terminal helper bytes/execution,
SQLite ABI, installed resource operations and rig.cmd daemon-subpath loading.
Receipt: pack-terminal-assets-dfaff96.json and its complete log. It does not
cover later source changes, the full daemon suite or deployment.

A subsequent bounded path-list audit inspected 1,496 public production source
files, excluding the private row before content reads. Candidate matches remain
an inventory rather than semantic portability proof. One real native temporary
directory reproduced a Rex resolver defect: a quoted absolute Windows PATH
entry returned unavailable despite containing the selected rex.exe. Rex now
unwraps a matching pair of directory quotes before absolute-path validation,
matching the native Herdr behavior. Earlier empty/relative entries and unmatched
quotes still refuse; no directory is skipped to select a different executable.
The discovery fixture's file was never executed and was removed afterward.

The regression failed before the change and passed afterward. Four complete
Rex adapter/transport/native-Job/wiring files passed 63 cases on Windows with
four POSIX process skips; WSL passed 60 with seven native-only skips after both
changed files were copied and byte-compared. Daemon TypeScript build and
whitespace checking passed. The route fixture used an owned synthetic Rex
responder; real Rex GUI/server acceptance remains unqualified. No original team
or running deployment changed, and no public push occurred.

### Native inherited server environment spelling (2026-11-03)

The Windows server selector previously read only exact uppercase TMUX,
PSMUX_DATA_DIR and USERPROFILE keys from a supplied environment object. Windows
child processes resolve those names case-insensitively, so a mixed-case key
could make inherited execution and the new-terminal attachment path disagree.
The selector now uses the existing child-environment lookup helper, including
its deterministic duplicate-key selection. The standalone attachment-metadata
helper uses the same platform rule for TMUX and TMUX_TMPDIR; POSIX remains exact.
No active server is migrated or stopped by these reads.

The selection regression failed before the change and passed afterward for
mixed-case inherited socket, data directory, user profile and duplicate keys.
Final complete selection/attachment files passed 50 on Windows with two
POSIX-only skips. A new real stock psmux 3.4.0 fixture launched a session using
mixed-case private environment keys, then listed and captured that same session
through the selected explicit attachment path; its receiver/session/root cleanup
passed. The first fixture assertion differed only in TEMP/Temp physical spelling
and was corrected by canonicalizing its owned root before the successful run.

The five changed source/test files were copied and byte-compared into the WSL
validation tree. Four complete related files passed 53 with one explicit opt-in
skip, including the real stub-seat daemon migration scenario. Daemon TypeScript
build and whitespace checks passed. This does not establish concurrent
server-name/PID exchange atomicity or literal-pipe session-name support, and no
running OpenRig instance or original team changed.

### Explicit native Rex window entry (2026-11-03)

The daemon's native Rex control mapping was previously unreachable through
`rig terminal open --window --provider rex`: the CLI unconditionally rejected
Windows before discovery. The explicit provider now uses the existing guarded
Rex view workflow. Windows discovers rex.exe from REX_BIN_DIR or absolute PATH
entries, including quoted entries, with case-insensitive environment lookup.
It never invokes /bin/sh or searches the macOS app bundle. Missing native Rex
still fails before any process or daemon request. Earlier relative/empty PATH
entries do not permit selecting a later executable.

Before opening a view, the CLI retains --autostart=false, explicit -S selection,
caller/daemon instance identity agreement, preview/expected-plan validation and
the existing uncertain-outcome behavior. The app switch is restricted to the
one attributable selectable app. Native mixed-case server/session/block markers
follow the child environment's lookup rule. Unrequested Windows Rex markers
continue to use the existing Windows Terminal route; an explicit Rex request
is required for this newly admitted path.

New native-routing fixtures cover both discovery sources and refusal of a
different or unconfirmed server before the open POST. Three complete Rex and
native preview/reuse files passed 42/42 on Windows. The changed missing-native-
Rex case passed separately; the known exhausted where.exe discovery case was
not repeated or counted as passed. WSL passed all four complete files, 56 cases
with one native-discovery skip, after four changed files were copied and
byte-compared. CLI TypeScript noEmit checking passed.

These are guarded CLI mapping/contract checks with synthetic Rex responses,
not a real Rex GUI/server qualification or a claim that an official Windows
Rex distribution is available. Native executable installation and real visible
app acceptance remain external prerequisites. No existing Rex app, main OpenRig
deployment or original team was contacted or changed.

### Native terminal control descendant custody (2026-11-03)

The CLI default terminal-window control executor still used ordinary execFile
on Windows. A real owned regression reproduced a detached child surviving its
parent's successful exit. Finite control calls now use the existing atomic
Windows Job executor through the paired daemon public surface; detached GUI
launches retain their separate lifecycle and POSIX control calls retain execFile.
This covers the default executor used by native Rex and Herdr control requests,
without changing their identity checks or retrying uncertain effects.

Real native tests verify descendant exit after parent success, exit status 7
and timeout, while retaining empty/quote/Unicode/operator argv, an explicit
synthetic environment value and stderr on failure. All five complete related
CLI files passed 143/143 on Windows. WSL's paired daemon was recompiled after
copying and byte-comparing the three changed source/test files; the same files
passed 140 with three native-custody skips. Daemon build, CLI TypeScript noEmit
and whitespace checks passed. The reproduced surviving child was explicitly
stopped during the failing fixture's cleanup; successful fixtures left none.

The installed package gate now also imports the installed terminal-window entry
and executes an owned literal-argv receiver through its default executor, to
check delivery of the new paired public export. That updated installed gate is
pending at this revision. The earlier installed receipts do not cover this
new export. No original team, provider, real GUI or running deployment changed.

The updated installed gate subsequently passed at clean source
d23b0930cb1c3f8cf5508ea0bbfb8898d7467a4f in 67 seconds, with matching
before/after HEAD and tracked-diff hashes. The actual installed terminal-window
entry loaded its paired export and preserved the literal receiver argv through
the native Job executor. Build/pack/isolated install, terminal helpers, SQLite,
installed resources and rig.cmd also passed. Receipt:
pack-terminal-assets-d23b093.json and its complete log. This supersedes the
pending installed-export check above only; the broader parity requirements,
real GUI/provider acceptance and full daemon-suite limitations remain open.
# Scoped native SFTP filename qualification — 2026-11-03

Installed mapped-attach gate at `6ed95f6638191855bd8f7cc817c144e42e5af9d4`
passed in 68 seconds with unchanged HEAD and tracked diff: actual native build,
tarball assembly, isolated-prefix install, installed CLI attach-module import,
and execution of the shipped helper against an owned controlled executable.
The probe verified the physical target/marker exchange, read-only flag and one
snapshot/attach in single-attach mode, alongside existing literal argv, SFTP
binary transport, native time/file helpers, SQLite and resource checks. Fixture
PATH was restored and temporary files removed. No real desktop or provider was
attached, and no deployment/publication occurred.

The preceding `412177e` gate failed because its strict receipt assertion still
expected three fields while the probe now reports `mappedSingleAttach`; that
contract was corrected and the complete gate rerun. The old failure remains
historical evidence, not a pass. Source stability here concerns tracked content;
the package build reports dirty identity with retained untracked diagnostics.
Leak-guard term checks without a rules file remain skipped, not validated.

`rig terminal attach` now uses the same verified binding wrapper for constrained
Windows names. An explicit attach-only mode returns after the first attachment,
preserving the manual command's semantics instead of following replacements.
Ordinary names and POSIX execution retain their direct attach path. The CLI
still clears nesting markers, inherits terminal stdio and propagates exit codes;
the existing locality/instance checks remain before launch.

Three related CLI/tile files passed all 32 checks, including native PowerShell
execution proving attach-only performs one snapshot/attachment rather than a
follow loop. Daemon build and CLI no-emit passed. The new shared exports and
modified helper still require installed-package qualification. Direct CLI
execution retains local `tmux` lookup rather than yet consuming the daemon's
pinned executable metadata; real desktop attachment is still unverified.

General native attach guidance now uses the canonical verified tile wrapper for
mapped names, preserving executable prefix arguments and the selected server.
The daemon records an absolute executable when startup's requirements probe
finds one; unavailable discovery retains existing executable lookup. Injected
test transports do not trigger that new discovery. Server-context reset clears
the recorded command. A wake diagnostic now passes the raw session name instead
of pre-quoting it before attach-command construction.

Twelve attach/server tests passed, including actual PowerShell execution of
generated general guidance over a controlled executable: the valid marker
attached, a wrong marker made no attach attempt, and prefix/server arguments
were preserved. Daemon build passed. Production startup discovery and stock
psmux desktop attachment remain unqualified; direct CLI attach and installed
asset qualification remain pending.

Mapped native view/tile attachment now carries canonical physical-name/marker
data in its generated wrapper. The PowerShell helper verifies exact presence,
marker and legacy ambiguity before selecting the physical route, rechecks on
replacement observation, and refuses an unverified initial mapped target rather
than falling back to direct attach. Logical labels/messages stay unchanged.
Native view recovery commands use that same verified wrapper for mapped names;
altered binding payloads fail canonical-wrapper admission.

Six tile/view tests passed, including actual Windows PowerShell execution over
controlled native executables: literal argv, replacement following, changed
identity, binding loss, initial absence, read-only flags and SSH forwarding.
Daemon build passed. An implementation error where ScriptBlock-local target
state differed from script scope was diagnosed from command receipts and fixed
using a shared routing-state object. These are helper/control-flow checks, not
stock-psmux desktop acceptance. General inventory/direct attach guidance and
installed-package qualification of the modified asset remain unfinished.

Physical-name phase 3 preserves existing ordinary native names beginning with
the codec prefix: an exact positive presence probe and an absent logical marker
qualify the legacy name. New creation refuses an already occupied legacy name.
If both a valid mapped binding and that legacy logical name exist, lookup
rejects ambiguity rather than preferring either. Transport/permission errors
remain unknown and do not cause identity fallback. Positive absence of both
candidates now produces the normal absent-session classification, including
post-stop lookup. Four related controlled files passed 229 checks and daemon
build passed. Real legacy-prefix, constrained-name cleanup, external attach and
concurrent exchange acceptance remain unfinished; no blocked real fixture was
retried in this phase.

Physical-name phase 2 now restores verified logical names in session/client
listings, active-window maps and scoped pane identifiers. A scoped pane obtained
from a mapped session resolves back to its verified physical server rather than
being encoded again. Batch capture validates and translates every requested
session; a missing binding produces an unknown capture without guessing a
target. Probe rollback compares the physical name under its identity condition.
Matching-looking names without a valid marker are not decoded as logical names.

Six related controlled files passed all 261 tests; daemon build passed. The
existing ordinary two-server stock-psmux batch-capture acceptance also passed
after the batch-path change with successful cleanup. The constrained-name real
fixture was not retried because its cleanup remains blocked by EBUSY. External
attach, legacy reserved-prefix lookup, mapped-name lifecycle cleanup and full
same-version/real acceptance remain unfinished; this is not complete arbitrary
session-name support.

Physical-name phase 1 now intercepts constrained native creation names and
exact/scoped target lookup. Creation requires a positive absent-name probe and
an explicit new-session identity receipt; the logical marker is installed under
a conditional identity check and read back before success. Target lookup
refuses a missing/mismatched marker rather than adopting a matching-looking
physical name. Four controlled adapter checks passed (fresh binding, occupied
refusal, missing marker, unconfirmed receipt), alongside 14 codec checks;
237 existing related checks passed before the final occupied-name precheck was
added, and daemon build passed afterward.

An initial real stock-psmux `owned|logical-name` probe passed creation, fresh-
adapter lookup, private environment update/read and missing-marker refusal with
cleanup. Extending it with occupied-name assertions then hit two EBUSY cleanup
failures; those runs are not passing acceptance and two task-owned temporary
directories were retained without process guessing. The fixture was adjusted
to preserve primary and cleanup errors together; it was not rerun afterward.
Listings/scoped pane identity decoding, probe rollback, legacy reserved-prefix
compatibility, external attach guidance and concurrent name exchange remain
unfinished. This partial implementation is local only and does not establish
complete arbitrary-name support or authorize deployment.

Physical session-name mapping implementation has started with a deterministic
binding module: constrained logical names map to bounded SHA-256 native names,
and canonical UTF-8/base64url metadata binds the original logical name to that
exact physical name. Ordinary names remain unchanged; the reserved encoding
prefix is itself escaped for new bindings. A physical name alone never grants
adoption authority. Fourteen module checks passed, including distinct-name
separation, marker mismatch, invalid UTF-8 and noncanonical metadata; daemon
build passed. This module is not yet wired into creation, target resolution,
listings, recovery, or attach guidance. Literal-pipe session support therefore
remains incomplete and no real stock-psmux name acceptance is claimed.

Presence-callsite review found only the producer-link diagnostic in
`session-transport.ts` using these APIs outside the adapter. It preserves null
and absent map entries as UNKNOWN, allows a positively present alias to win, and
does not turn lookup failure into restart/reconfiguration. Its stale comment
claiming an atomic single listing was corrected to one batch API call; native
queries may be independent. Six selected existing diagnostic regressions passed
(259 other tests excluded by name filter), including no error/token text leaks,
no individual retries at the diagnostic layer, endpoint fallback and prompt
guards. This is callsite-scoped evidence, not full session-transport acceptance.

Usable-environment presence now agrees with exact value reads. Native psmux
uses deduplicated selected-key queries instead of splitting an ambiguous raw
multiline listing, fixing case-alias false absence and assignment-looking
continuation lines being treated as distinct variables. Unknown/unreadable
results remain `null`; missing/empty/whitespace-only values remain false.
POSIX retains its one-listing fast path and performs selected lossless reads
only for backslash-ambiguous values, fixing escaped whitespace misclassification.
Native batches now make per-key queries (plus selector qualification where
needed); they do not promise one atomic listing snapshot.

Real stock psmux direct-process fixture passed these presence cases with exact
cleanup. Real isolated WSL tmux additionally verified usable-presence and batch
results for empty/whitespace controls, CR/LF, Unicode and literal escapes. WSL
four selected files: 22 passed; Windows three related files: 221 passed; daemon
build passed. Five explicit public file hashes matched the scoped WSL overlay
before/after. These results do not refresh full-workspace or interactive/warm
startup acceptance.

Real stock psmux 3.4.0 cross-home global-environment acceptance passed using
two `selectTmuxServer(mode: isolated)` homes and equal session names. After
setting distinct synthetic global values in both namespaces, each home read
its own value and a newly created direct Node window inherited that same value.
Stopping one home's exact session left the other home's pane marker and global
value intact. The existing isolation/migration checks in that selected test also
passed and owned resources were cleaned. One selected real test passed; the
other test in that file was excluded by the name filter, not covered by this
run. No product change, deployment, publication or team restart was needed.

Real stock psmux 3.4.0 parent-environment suppression acceptance passed under
an owned private registry: a synthetic global `CLAUDECODE` value remained set,
the selected session's override was removed through a lowercase alias with a
removal marker, and its next directly respawned Node process received no such
variable. The sibling session retained its distinct override and remained
present; the global value was unchanged. Existing implementation passed and no
speculative global-routing change was applied. The public opt-in regression
test kills only its two exact owned sessions and cleaned its fixture. This is
same-registry session suppression evidence, not cross-home global-environment,
interactive-shell or warm-standby acceptance.

Native selected-environment response keys now use the established Windows
environment lookup rule rather than requiring the query's exact key spelling.
Real stock psmux returned the stored uppercase name for a successful lowercase
query, which previously caused recovery reads to fail. The owned direct-child
fixture now verifies missing-versus-empty values, case-alias multiline reads,
and removal through a lowercase alias followed by absence under the original
name. It passed with successful exact-session/config cleanup. Three related
controlled files passed all 220 checks; daemon build passed. POSIX key matching
remains exact. This does not qualify every Unicode environment-name alias or
replace the still-open interactive/warm-start acceptance.

Real isolated WSL tmux 3.4 exposed a further POSIX readback defect: printable
responses encode controls using VIS_CSTYLE/VIS_OCTAL while leaving literal
backslashes unescaped. POSIX environment reads now request the shell-form
representation when a backslash makes the raw value ambiguous, then parse its
closed quoted envelope as data without evaluating commands. Literal backslashes
are escaped in this representation, distinguishing CR/LF and octal-looking
literal text. The encoding is grounded in upstream
[show-environment](https://github.com/tmux/tmux/blob/3.4/cmd-show-environment.c)
and [client printing](https://github.com/tmux/tmux/blob/3.4/server-client.c).

Real tmux checks passed for empty/multiline/Unicode values, trailing CR/LF/CRLF,
literal backslash escapes, quotes, dollar/backtick and control bytes. WSL four
selected files: 20 passed, including the exhaustive legacy/argv equivalence
oracle updated to exercise the additional quoted read. Windows related files:
59 passed; daemon build passed. Five explicit public source/test file hashes
matched the Windows source and WSL overlay before/after; this is a scoped
overlay, not a refreshed full-checkout comparison. The exact owned socket and
temporary directory were removed; no existing tmux server was selected.

Native session environment reads now retain complete selected values instead
of truncating at their first newline. Before interpreting a multiline response,
a read-only missing-variable probe qualifies selector support; older servers
that return an entire environment rather than the selected variable are refused
without exposing that body. Exactly one protocol LF is removed, preserving a
value's trailing CR in both psmux and POSIX tmux paths. Real stock psmux 3.4.0
reproduced the old truncation and passed after repair, including empty values,
trailing CR/LF/CRLF, Unicode and assignment-looking lines inside values.
Four related controlled test files: 221 passed, two opt-in interactive cases
not run; daemon build passed. Real POSIX tmux multiline acceptance remains to
be refreshed; controlled POSIX byte-preservation checks passed. Legacy whole-
environment servers cannot yet supply lossless multiline reads through this
interface and remain explicitly unsupported for that operation.

Real stock psmux 3.4.0 direct-first-child environment acceptance passed: a
synthetic value containing quotes, backslash, format-looking text, LF/CRLF and
Unicode reached the initial direct Node process exactly through protected
initial configuration. A second independent session/server in the same owned
registry received no such variable; recorded multiplexer argv contained no
synthetic value. Exact owned sessions, private config and temporary receiver
files were cleaned successfully. This is first direct-process evidence, not
interactive shell startup, warm standby, process-list observation or desktop
reattachment acceptance. Earlier exhausted interactive experiments stay open.

Real stock psmux 3.4.0 batch-capture acceptance passed with two task-owned
sessions under a private `PSMUX_DATA_DIR`, each printing a distinct marker.
Batch results matched each session's independently captured bytes and contained
no sibling marker. A batch with an absent middle session correctly marked it
missing and preserved both live sessions' captures. The existing implementation
passed; no speculative single-session fallback was added. The opt-in public
regression test stops only its two exact sessions and removed its temporary
fixture successfully. This does not qualify arbitrary physical session names,
attached GUI clients, or interaction/recovery paths outside capture.

Native psmux `switch-client` now places its actual destination operand before
the literal client name. A client value equal to `-t` previously hid the real
scoped destination from routing discovery, leaving its encoded identifier
untranslated. Controlled argv regression checks now verify server namespace,
decoded session destination, session id and preserved literal client data for
both flag-shaped and ordinary client names. Four related adapter/exact-target/
service files passed all 223 tests; daemon build passed. POSIX argv and legacy
shell command order stay unchanged. This is controlled routing evidence, not
real attached desktop-client acceptance; stock psmux physical-name limitations
and earlier exhausted interactive experiments remain open.

Full CLI/TUI/UI directory checkpoint at
`c265738c7d853ef91d0f9217e7ed574cc699a6cf` selected 758 test files per platform.
Windows: 9,620 total, 9,501 passed, one failed, 118 skipped, 11m27s. WSL: 9,619
total, 9,391 passed, zero failed, 228 skipped, 5m19s. The sole Windows failure
remains `terminal-window-windows.test.ts` / system discovery with an owned PATH
containing no system tools: Windows Terminal was reported unavailable and the
native lookup returned no matching files. Earlier bounded investigation is
exhausted; this checkpoint does not claim that failure fixed. No other test
failed in this run. Skips remain unverified behavior, not completion.

Windows HEAD and tracked diff remained unchanged. WSL paired daemon build
passed, 4,712 public regular-file hashes matched before/after, and existing
private dependency identity matched after the suite without source viewing or
copying. Six documentation links and generated/untracked mirror entries remain
outside equivalence. This is not a daemon full-suite, deployment, real-provider
or stock-psmux acceptance result. Runtime versions differ, so elapsed times are
test receipts and not a performance comparison.

A separate owned native-local fixture also copied all six exact reserved and
trailing names (`con`, `nul`, `aux.txt`, `trailing`, `trailing.`, `trailing `)
with distinct correct bytes. It exercised the existing built module without
changing frozen source; this scoped finding required no product change.

Updated paired transfer checkpoint at `bf9500221851458d9611fcf0a22cd139a822d318`:
the same sixteen explicit test files selected, 189 tests per platform. Windows:
164 passed, zero failed, 25 skipped. WSL: 124 passed, zero failed, 65 skipped.
This includes new native-local and SFTP time tests plus the prior protocol,
recovery, identity, mode, source-size and command checks. WSL Linux subsystem
was explicitly enabled; native-Windows-only cases remain skips there. Windows
HEAD/tracked diff stayed unchanged. WSL paired daemon build passed and all
4,712 public regular-file hashes matched before/after; existing private source
was excluded and its indexed Git identity checked around the build. Six links
and generated/untracked files remain outside mirror equivalence. These are
transfer-scoped results, not full-workspace, deployment or remote-provider proof.

Out-of-range native-local link acceptance now passed all four combinations of
file/directory link and -1/2^32 seconds: initial copy, dry-run drift detection,
repair without file retransmission, unchanged referent timestamps and contents.
The complete time-range test file passed six checks without skips. Installed
package gate at `941b7143f331e1874d76c2593d4a1472ab9552e1` passed in 69 seconds
with unchanged HEAD and tracked diff. It exercised installed local-copy code
and compiled native helper, independently reading back the copied 1969 time
through Windows .NET, plus the existing terminal/SFTP transport, SQLite and
resource checks. This was an isolated-prefix install, not deployment or publish.

Native-local copy now uses the identity-checked Windows time reader for source
and destination comparisons and restoration. It explicitly applies captured
times after copying bytes, avoiding `fs.cp`'s own wrapped `stat` timestamps.
Two real native tests preserve file and directory times at -1 and 2^32 seconds,
verify copied content, and verify repeat previews require no retransmission.
The 2^32 file case starts with an equal-size destination at epoch zero, catching
the previous false unchanged classification. Combined local-copy/time checks:
25 passed, three POSIX mode checks skipped; daemon build and CLI no-emit passed.
The reader exposes millisecond values for local copies and separately floors
integer protocol seconds. Existing file/directory-link and readonly regression
checks passed; out-of-range link-time acceptance remains separately unverified.

SFTP local-endpoint metadata now reads access/write times through a no-follow
Windows file handle and checks its volume/file identity against the caller's
`lstat`. Signed native 100ns values are converted with integer arithmetic before
flooring to protocol seconds. Five dedicated checks passed, including accurate
-1/0/2^31/(2^32-1)/2^32 readback, stale-identity refusal, and real-subsystem
copy refusal that retains target bytes for out-of-v3-range source times.
The recursive native SFTP file separately passed 27 checks with two skips;
daemon build and CLI no-emit passed. This fixes accurate source capture for
SFTP; it does not extend SFTP v3 time representation or yet repair native-local
copy's separate timestamp read path. Handle comparison is not an atomic snapshot
of every metadata field and does not prevent later concurrent source changes.

Standalone Windows Node 24.14.1 time probe (outside Vitest) reproduced the
out-of-range readback discrepancy: setting -1 Unix seconds was read by Node
`lstat` as 4294967295, and setting 4294967296 was read as zero. Bigint stat had
the same discrepancy. Independent Windows PowerShell/.NET UTC reads returned
the requested 1969-12-31 and 2106-02-07 timestamps. In-range 0, 2147483648 and
4294967295 agreed. This local readback defect occurs before SFTP encoding;
the encoder guard alone cannot establish source-time integrity. A native
handle-based time reader and its use by native copy remain implementation work.
The probe used owned temporary files, removed afterward; no runtime deployment.

SFTP v3 timestamp encoding now reports its unsigned 32-bit seconds limit
explicitly for regular and no-follow link metadata rather than exposing a
generic Buffer range error. Direct real-subsystem tests reject -1 and 2^32
seconds while preserving the destination's complete observed attributes and
bytes; protocol tests: six passed. This improves failure diagnosis, not time
range parity with rsync or NTFS. An attempted filesystem-to-SFTP range fixture
observed local timestamps already wrapped before transfer (-1 read as 2^32-1,
2^32 read as zero); its cause is unqualified and that fixture is not counted as
passing copy acceptance. A direct protocol fixture avoids that assumption.

Matching public-source WSL transfer checkpoint at `620a213`: the same ten
explicit files selected on Windows ran with the isolated Linux SFTP subsystem
enabled. WSL: 146 tests, 107 passed, zero failed, 39 skipped. Windows at the same
production source: 127 passed, zero failed, 19 skipped. Counts differ by platform
selection and do not establish coverage of skipped behaviors. The WSL daemon
dependency build passed; 4,710 public regular-file hashes matched before/after,
and the existing private dependency matched its indexed normalized Git blob
before/after the build without being viewed or copied. Six documentation links
and existing generated/untracked files were not reconciled. Windows Node
24.14.1 and WSL Node 24.11.0 differ; no performance comparison is asserted.

Integrated Windows file-transfer checkpoint at
`c154d6c18b2a914d7c654c4b101af81d2a76e061`: ten explicit CLI test files,
146 tests, 127 passed, zero failed, 19 skipped. This includes command/planner,
protocol, transport custody, text identity, staging permissions, directory
recovery and captured-source-size checks. The default run did not enable the
Linux-subsystem cross-endpoint opt-in; its separate 28-pass/1-skip result above
remains separately scoped. Source HEAD and tracked cleanliness were checked
after the run. This is not a full workspace or Linux comparison checkpoint.

Local path policy comparison now treats Windows extended-length drive and UNC
spellings as the same locations as ordinary paths, retaining the original I/O
spelling. Scoped checks cover each existing denied local home segment and both
directions of custom active-home namespace spelling. UNC checks are lexical
policy checks, not remote share access or acceptance. CLI no-emit passed.

Explicit remote paths now receive the same alias check before opening transport,
including intermediate components and both upload/download directions. Two
command-level copy tests verify rejection before transport and preservation of
the ordinary file's original bytes. Updated native recursive check: 28 passed,
1 host-capability skip; CLI TypeScript no-emit passed.

Local Windows copy I/O now uses namespace-aware absolute paths, retaining literal
NTFS DOS-reserved names and trailing dots/spaces. An opt-in Linux SFTP subsystem
to native Windows receiver check copied distinct `con`, `nul`, `aux.txt`,
`trailing`, `trailing.`, and `trailing ` files and directory witnesses, verified
all twelve contents and exact enumerated names, and verified a repeat preview
requires no retransmission. This is a receiver/subsystem check, not SSH network
or provider continuity acceptance.

The installed Windows OpenSSH subsystem omitted reserved entries and normalized
trailing-dot reads to another entry. Known Windows remote endpoints (PowerShell
metadata or drive-qualified protocol paths) therefore reject enumerated reserved
and trailing names rather than copying aliased bytes. A server can omit entries
before the client sees them; this guard cannot certify complete enumeration.
Windows OpenSSH exact-name parity remains unqualified. Ordinary recursive copy
can have copied preceding siblings before encountering a rejected entry.

Validation: Windows recursive SFTP file 26 passed, 1 host-capability skip,
including the explicit WSL subsystem opt-in and Windows alias refusal; CLI
TypeScript no-emit passed. No deployment or push.

