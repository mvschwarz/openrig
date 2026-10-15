# Native Windows support experiment

Tracking: https://github.com/mvschwarz/openrig/issues/88

This branch implements native Windows headless Codex/Pi launch, message delivery,
process observation, snapshot/down/restore, and graceful daemon stop. It remains
an experimental fork; it is not an upstream Windows support announcement.
RepoStew migration is deferred.

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
