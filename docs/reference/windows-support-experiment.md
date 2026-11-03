# Native Windows support experiment

Native Windows support is a Draft implementation for OpenRig. Linux/WSL remains
the established alternative. The native implementation uses PowerShell and
psmux; OpenShell is not a prerequisite for ordinary local agent sessions.

## Requirements and entry points

- Use the repository's supported Node.js version and build/install instructions.
- Install stock psmux and make its tmux.exe available on PATH before unrelated
  tmux installations. The native development checks used psmux 3.4.0.
- Install and sign in to the agent/provider you intend to use.
- Use Windows OpenSSH for remote SSH/SFTP operations. A remote host needs the
  corresponding SSH/SFTP service and an ordinary usable login.
- Native helpers use Windows PowerShell/.NET. Creating symbolic links requires
  Windows Developer Mode or an account with the appropriate permission.

Useful checks from the installed environment:

    node --version
    tmux -V
    rig --version
    rig doctor

Use the normal rig commands for setup, daemon control, agent sessions, terminal
views and file movement. Native support does not require replacing the default
terminal, starting an OpenShell engine or enabling every optional integration.

## What this branch adapts

| Area | Native Windows implementation |
| --- | --- |
| Launch and lifecycle | PowerShell/cmd argv, npm CLI entries, selected Node, process observation, daemon start/stop and child cleanup |
| Terminal | psmux session/pane routing, input and capture, selected servers, environment transport, attachment and runtime-switch paths |
| Providers | Claude, Codex, Pi and OMP launch/resume integration; ACP process and cancellation handling; packaged hooks |
| Files and remote tools | Native local copies, OpenSSH SFTP, explicit PowerShell SSH command routing and host registry fields |
| UI and TUI | Windows paths, named pipes, command rendering, local reading, terminal window routing and keyboard handling |
| Installation and resources | Native npm entry resolution, package assets, skill/reference projection and portable Node helper scripts |

For feature evidence and remaining work, see
[the native feature status](windows-native-parity-status.md).

## File movement and platform differences

Linux/WSL uses rsync archive mode. Windows uses native filesystem operations for
local movement and SFTP for remote movement, avoiding a local rsync dependency.
The user-facing intent is recursive copy, directory merge, retained extra target
files, links, timestamps, readonly handling and preview. A trailing source
separator selects directory contents rather than the source directory itself.

Windows drive/UNC paths, filename restrictions, link privileges and filesystem
case policy remain Windows features. POSIX modes/UIDs and Windows SID/DACLs are
different models; exact translation of those models is not a completion target.
Ordinary copies do not add a source-DACL synchronization policy. The extra
local-copy ACL synchronization changes were reverted.

## Optional integrations

Herdr and Rex are optional terminal views. OpenShell and Podman are optional
environment-engine integrations, not replacements for PowerShell or psmux.
Using one requires a usable selected client/engine path. An unsuccessful native
OpenShell source build does not prevent ordinary native OpenRig operation.

Stock psmux is the supported native adapter path. Initial/respawn environment
values use its existing launch and configuration mechanisms; no custom psmux
source patch or OpenRig-specific capability command is required.

## Review scope

The goal is Linux/WSL user-function coverage and remote interoperability using
appropriate native implementations. It is not identical OS security primitives,
every historical test passing, or exhaustive reboot/power-loss acceptance.
Ordinary host doctor connectivity checks remain available; the extra Windows
firewall/account/sshd hardening profile is outside this native feature port.
Keep the focused regression checks relevant to changed functions. Historical
probe logs and repeated suite counts are not the product specification.
This document does not claim stable native support or a fresh deployment.
