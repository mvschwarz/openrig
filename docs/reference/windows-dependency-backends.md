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
