# Canonical Windows dependency backends

Each migrated operation has one Windows mechanism. Callers may select a package,
account, target host or lifecycle policy; they do not independently parse npm
shims, inspect process memory or reconstruct psmux commands.

| Operation | Canonical implementation | Callers / policy |
| --- | --- | --- |
| Native executable and npm shim resolution | `domain/windows-command.ts` | Provider, Pi, community and ACP adapters delegate here. Runtime package allowlists and Pi's retained Node interpreter are explicit policy inputs. |
| PowerShell helper executable | `domain/windows-executables.ts` | Native processes use the SystemRoot-qualified helper. `shell-bootstrap` is explicit for commands entered through multiple shell grammars or the remote SSH shell; those use the target shell's PATH. Interactive pane-shell selection remains separate. |
| Owned process parameters/environment | `domain/windows-process-facts.ts` | Home-selector and terminal-marker projections use the same bounded PEB reader and owner/bitness checks. TUI re-exports the terminal projection; arbitrary environment values are never returned. |
| Local control endpoint | `domain/local-control-endpoint.ts` | TUI and Herdr App share canonical path/alias identity and pipe construction. Each service retains its own namespace. |
| Native terminal attachment | `domain/terminal/windows-tile-attach.ts` and `assets/terminal/windows-tile-attach.ps1` | Herdr, Herdr App and ordinary native views use the same server/session binding and argv. |
| npm tooling executable | `scripts/npm-command.mjs` | Installer, build tools and shipped polluter finder use Node/npm-cli.js on Windows. `mirror-skills` projects and checks the exact helper bytes in the shipped skill; do not edit that generated helper independently. |

## Herdr App

On Windows the provider starts `assets/terminal/herdr-app-viewer.mjs` with a
journal nonce and data-only argv payload. Local writable cells delegate their
reveal gate to the existing native tile helper. It starts a read-only psmux
client, waits for the App's acknowledgement file, ends only that owned client,
flushes pending console input with `FlushConsoleInputBuffer`, then starts the
writable attachment. A failed/expired gate never starts the writable client.
After attachment ends, the viewer remains alive until the normal journal/layout
removal protocol ends it. No shell is left in the cell.

Set `HERDR_APP_SOCKET` to the Windows named pipe actually exposed by the selected
herdr-app client, for example `\\.\pipe\my-herdr-window`. The daemon, CLI and TUI
use the same selector. Without an override, the endpoint is derived from the
App home through `localControlEndpoint(..., "win32", "herdr-app")`. A filesystem
`.sock` file is not used as proof of a Windows pipe. Ambient selection requires
the core terminal markers and the explicit endpoint; the daemon still asks the
window before choosing it.

The external herdr-app/herdr-core build must provide its native terminal host
and the selected pipe server with the existing JSON-line protocol. These
OpenRig adapters do not install or implement that external GUI/server. Protocol
and native argv tests establish the OpenRig contract; they are not a claim of
live GUI acceptance.

## Deliberate boundaries

Process inventory (CIM/census), exact process parameters (PEB), and open-file
holders (Restart Manager) answer different questions. Job Object ownership and
taskkill fallback also retain their different lifecycle guarantees. Local file
copy and SFTP share native file operations where appropriate but retain their
distinct transport semantics. They should not be collapsed into one oversized
helper merely because they replace different uses of a POSIX utility.

For a standalone copy of the Windows installer or polluter finder, include the
sibling `npm-command.mjs` helper. The repository and shipped skill already carry
it. Release packaging still uses the existing Git-for-Windows build-shell
contract; that build-time dependency is separate from native runtime launch.
# Upstream refresh: 2026-11-19

The Windows candidate is rebased onto upstream `2f637b78e9b57138f44de14213b5dcc822d5b047`.
New upstream consumers retain the same native dependency boundaries:

| Capability | Canonical Windows implementation | Consumer rule |
| --- | --- | --- |
| Process census and PID creation identity | `domain/windows-process-table.ts` | Preserve an observed PID and parent when identity fields are unreadable; mark it explicitly. Missing identity is neither process absence nor a unique runtime. Lifecycle reservations read one PID's CIM creation stamp through this same backend. |
| Run-bound Pi/community reporting | `domain/runner-grant-launch.ts` with `adapters/windows-launch.ts` | Prepare the existing structured `ProcessStartInfo` launch after environment selection. Transfer the grant through the selected private psmux session environment and the child environment, never token argv or `/bin/sh`. |
| Herdr live attachment reuse | `domain/terminal/herdr-live-workspace.ts` | CLI and daemon share the proof, including native per-session psmux client inventories and the existing tile-attach decoder. The CLI's compatibility export delegates to it. |
| Herdr follow-close endpoint identity | `domain/terminal/herdr-viewer.ts` | Compare endpoints with `sameHerdrPath`; compare real private directories with `sameViewerCwd`. Named pipes are not directories. |
| Seat committed-memory limits | `domain/windows-job-process.ts` and `domain/windows-seat-job-readback.ts` | Share the Job interop with finite probes, with a distinct persistent guardian lifecycle. Confirm current pane lineage, target membership and the actual limit; guardian loss or unprovable lineage is unknown. |
| Native plugin projection | `domain/windows-claude-plugin-hooks.ts` | Accept the finite shipped Node command grammar with or without the upstream `exec` prefix; preserve binary plugin bytes outside the two hook manifests. Fork projection revision `0.1.35` advances older installed projections honestly. |

Windows memory-only seats use an atomic Job assignment before target code and a
guardian outside that Job until the last member exits. `memory_max` means total
Job committed memory on Windows; it is not cgroup RAM/page-cache accounting.
Fresh launches require actual readback. Recovery retains structured diagnostics
and never replays an uncertain launch. If the guardian dies, readback reports
unknown and the seat can remain alive without its former limit; operator
inspection is required. Orphaned descendants with an unprovable original lineage
also remain unknown rather than receiving an inferred cap.

A Windows active-process limit does not count threads as Linux `TasksMax` does.
`tasks_max`, including a combined tasks-and-memory request, remains explicitly
unsupported. The native implementation does not silently substitute a different
resource count.
