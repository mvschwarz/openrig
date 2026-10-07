# Native Windows Codex/Pi experiment

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

## Reproduce

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
