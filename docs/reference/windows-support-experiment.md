# Windows support experiment

Status: experimental foundation. Native Windows is not yet a supported runtime.
Tracking: https://github.com/mvschwarz/openrig/issues/88

## Delivery plan

1. Keep WSL2 as the usable deployment path. Run Node, tmux, Codex and Pi inside
   Linux, with Linux-local state and separate provider authentication. Validate
   live replies and snapshot/warm restore before moving existing work.
2. Remove POSIX shell utilities from workspace build preparation. Preserve the
   packaged CLI schemas, templates, LICENSE and README, and POSIX executable bits.
   This independently reviewable change is implemented and validated.
3. Introduce a PowerShell launch path that accepts only generated literal argv,
   sets a validated environment, stages a short invocation and refuses unknown
   shells. Resolve standard npm Pi launchers through Node rather than cmd.exe.
   These foundations are implemented on this branch.
4. Treat psmux as a distinct terminal backend. psmux runs a server per session,
   so local `%N` IDs need session scope. This branch preserves both in an opaque
   pane reference and sends an explicit global session selector before the local
   pane selector. Buffer loading/deletion use the same server scope. Unscoped
   process batching falls back to scoped reads. Complete protocol conformance
   tests for guarded multi-seat lifecycle before upstreaming this backend.
5. Complete Windows process ancestry, termination receipts, cold recovery and
   terminal/UI acceptance. Only then add a Windows CI lane and a support claim.
   These are outstanding; WSL success does not establish their correctness.

## Evidence collected on 2026-10-08

WSL2: Ubuntu 24.04, Linux 6.18.40.1, Node 24.14.1, tmux 3.4, OpenRig 0.6.6,
Codex 0.161.0 and Pi 1.0.4. Both managed seats answered unique messages. After
snapshot/down and warm restore, both recalled their preceding message without
being given it again. No kernel/operator, suspend, reboot or GUI acceptance was
included. Report: https://github.com/mvschwarz/openrig/issues/88#issuecomment-6043925546

Native Windows: psmux 3.3.8, PowerShell and Node. Full workspace build and
workspace typechecking pass. The real terminal test runs two sessions with
duplicate local pane IDs and verifies exact native arguments containing spaces,
apostrophes, Unicode, shell metacharacters, an empty value and a trailing
backslash, plus an environment marker. The selected session writes the expected
result through its scoped pane reference.

The complete native managed Codex/Pi rig **does not pass readiness**. Both seats
remain attention-required after startup timeouts. No successful native model
reply or native resume is claimed. After three targeted fixes, further launch
changes were paused: compatibility between psmux's independent session servers
and the full guarded terminal binding protocol remains an unproven assumption.
Isolate that protocol with a multi-seat conformance harness before resuming.

## Reproduction

Use Node 22 or 24 and install dependencies with `npm ci`, then `npm run build`
and `npm run lint`. Build preparation fixtures run with:

```sh
node --test scripts/prepare-workspace-build.test.mjs
```

On Linux, also run `node --test scripts/cli-license.test.mjs` to verify the
actual npm archive retains the original license and README.

Focused runtime tests:

```sh
npm exec --workspace @openrig/daemon -- vitest run test/windows-launch.test.ts test/windows-pi-command.test.ts test/pi-runner.test.ts
```

The native terminal test is opt-in and creates/kills only its own uniquely named
test sessions. It requires the absolute path to the real psmux `tmux.exe`:

```powershell
$env:OPENRIG_TEST_PSMUX = 'C:\path\to\psmux\tmux.exe'
npm exec --workspace @openrig/daemon -- vitest run test/windows-terminal-native.test.ts
```

Never include provider authentication, session environments, staged launch
scripts or raw argv containing credentials in public diagnostics. Keep runtime
state and provider files outside the source checkout.
