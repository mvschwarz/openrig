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
| Optional engines | Windows Podman named-pipe observation and OpenShell adapter changes; actual use still requires a usable engine/client |

Implemented does not mean every optional client, provider, architecture or host
combination has been exercised. Keep actual missing functions distinct from
platform differences and unavailable external dependencies.

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

Keep function-level regression coverage and honest error reporting. Do not turn
old failing suites, skipped optional checks or separate host-security exercises
into new feature requirements. No paused team, deployed daemon or provider
configuration is changed by this documentation cleanup.
