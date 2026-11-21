# Native Windows feature status

This is the feature inventory for the native Windows Draft. It replaces the
chronological acceptance log; it is not an all-green certification checklist.
For prerequisites and usage, see [the support overview](windows-support-experiment.md).

## Scope

Implement the user functions available on Linux/WSL and allow the remote tools
to interoperate. Use each operating system's natural filesystem, permission and
process mechanisms. Extra security hardening, exact SID/UID/ACL translation,
repeated full-suite runs and exhaustive host fault testing are not additional
completion requirements. Ordinary native operation uses PowerShell and psmux.

## Implemented areas

| Area | Work retained in the Draft |
| --- | --- |
| Native process launch | Literal argv, npm shims, pinned interpreters, environment/home selection, managed-runner and hook entry points |
| Daemon and agents | Native start/status/stop, restart, selected provider launch/resume/fork, ACP cancellation and detach handling |
| Terminal | Scoped stock psmux routing, input/Enter/capture, environment values, selected-server isolation, native names and recovery paths |
| File commands | Local native copying and binary SFTP, previews, directory merges, readonly replacement, links, timestamps and native filenames |
| Remote commands | Host registry shell/SSH options, PowerShell execution, remote lifecycle and provider-recovery command rendering |
| UI/TUI | Native reading and navigation, server-path syntax, named pipes, Ctrl-C, window commands and viewer integration |
| Services and resources | Native Compose/readiness, package/install helpers, authored resource operations, skill mirrors and portable shipped scripts |
| Optional engines | Windows Podman named-pipe observation and the existing OpenShell driver; actual use still requires a usable engine/client |

Implemented does not mean every optional client, provider, architecture or host
combination has been exercised. Keep actual missing functions distinct from
platform differences and unavailable external dependencies.

## Upstream integration audit — 2026-11-12

The Windows change was rebased as one integrated change onto upstream
`aae4395b2555ef8092935d7f5a1a48e21845dc19`. The previous Draft head
`63d126f1b493d6ab733b4ec6e1e6c404e58b5fd7` remains a local backup. This audit
does not deploy the new build or start a managed team.

| Capability | Native implementation and audit result |
| --- | --- |
| Daemon lifecycle | Windows daemon control and detached process launch retained; production remains stopped during this audit. |
| Terminal/process observation | Stock psmux argv transport, scoped names, process census and console/lineage checks retained. Linux systemd user scopes remain Linux-specific. |
| Open-file holders | Windows Restart Manager implementation in `windows-file-holders.ts`; ordinary Windows operation does not require `lsof`. |
| Provider launch/resume/fork | Pinned native executable/npm Node entry, selected-history guards, upstream non-login-shell selection and launch wrappers integrated. Managed Windows wrapper execution now forwards exact literal argv. |
| Claude continuation capture | Owned Windows process argv and the named `CLAUDE_CONFIG_DIR` selector are read natively; npm Claude help is invoked with its retained script. General environment capture is deliberately not claimed. |
| Pi account switches | Canonical session identity and isolated account-switch state root now also feed the native runner verifier. Live provider/OAuth acceptance is not renewed here. |
| Community harnesses | Upstream first-input/model/conversation/wrapper assignments are decoded into Windows child environment fields; recognized npm launchers use Node directly. |
| ACP and `rig exec` | Windows process marker discovery accepts the connector's marker name. New `rig exec` resolves native/npm PATH entries and uses the start-identity-bound cancel request channel instead of cross-process SIGINT. Owned fake-agent execution/cancel is covered; paid/live adapters are not renewed here. |
| Refocus coordination | New upstream short state transitions use the Windows process-owned named pipe rather than requiring symbolic-link privileges. Rendering stays outside the lock. |
| File and remote tools | Native local-copy/SFTP and PowerShell SSH paths retained; host selection and SSH option separator preserved. Focused native tests do not replace a fresh cross-OS host matrix. |
| Packaging/resources | Portable npm/build helpers, npm pack JSON parsing and Windows skill-directory naming retained with upstream additions. |
| Optional Podman | Native owned-pipe/rootless-engine attribution retained alongside upstream positive compatibility-API volume inventory. This is observer coverage, not a live OpenShell deployment. |

The later shared-backend consolidation replaces the Windows Herdr App
viewer/gate and endpoint paths described in the initial integration audit.
Its external client still needs to expose the selected native terminal/pipe
server; protocol fixtures alone are not Windows GUI acceptance. The earlier
Herdr/psmux, Rex, remote OAuth and optional OpenShell limitations below remain.

Validation for the integrated revision includes the workspace build/typecheck,
focused launch/restore, native process/file/remote command and refocus tests,
plus portable packaging tests. POSIX-only shell/lock cases remain explicitly
skipped on Windows. No complete multi-OS suite, production deployment or live
GUI/provider/remote-host acceptance is claimed.

## Existing functional evidence

Earlier scoped runs exercised the following paths. They are historical evidence
for those revisions, not renewed current-head claims or prerequisites to repeat.

- The user confirmed a visible native TUI and working help navigation.
- Real local Pi/Codex OAuth sessions completed input, reopening, compaction and
  scoped snapshot recovery. A combined Pi/Compose restore retained its service
  volume contents and conversation marker.
- Owned Windows-to-Windows SSH/SFTP transferred Unicode, spaced and binary file
  fixtures with matching bytes. A remote daemon survived SSH disconnect and
  preserved its queue through stop/start after native lifecycle repairs.
- Native package probes exercised build/pack, isolated installation, SQLite,
  the actual rig.cmd entry and installed resource/helper operations.
- Stock psmux and filesystem checks covered native argv, multiline input,
  selected environment values, local copies and symbolic links on the enabled
  development host. WSL subsystem checks also exercised POSIX SFTP file paths.

## Remaining functional or external dependencies

- Real remote Pi continuity was deferred after an OAuth refresh failure. It
  needs a working remote sign-in when the user elects to resume that check.
- Actual Herdr-to-stock-psmux attachment exposed an unresolved integration gap;
  real Rex GUI and mapped-name/runtime-switch client continuity are not fully
  qualified. Ordinary PowerShell/psmux use is a separate path.
- A usable native OpenShell client was not established by the source-build
  experiment. Optional OpenShell usage needs a compatible selected client path;
  it is not a default installation or delivery gate.
- Windows-to-Windows SSH/SFTP evidence and standalone WSL subsystem evidence
  do not by themselves prove every Windows/Linux remote-host combination.

## Boundaries retained

The additional local-copy protected-DACL cloning and merge-time ACL changes
were reverted. Basic local copy functionality remains. Do not reintroduce them
as a Linux archive-mode requirement: that command does not request full ACL
preservation. POSIX permissions and Windows access control remain OS-specific.
SFTP upload ownership is assigned by the receiving account/server; ordinary
replacement does not require changing the stage back to an old target's UID/GID.

Keep function-level regression coverage and honest error reporting. Do not turn
old failing suites, skipped optional checks or separate host-security exercises
into new feature requirements. No paused team, deployed daemon or provider
configuration is changed by this documentation cleanup.

## Shared backend consolidation

The command/npm resolver, helper PowerShell locator, process-parameter reader,
local pipe endpoint and Herdr App native attachment now share their canonical
Windows implementations. See [the backend contract](windows-dependency-backends.md).
Herdr App no longer constructs POSIX viewer/gate commands on Windows. Its external
client must still expose the selected native terminal and pipe server; no live GUI
acceptance is claimed by this source refactor.
