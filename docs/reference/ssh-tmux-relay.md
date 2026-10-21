# Explicit SSH tmux relays (Codex)

A local tmux pane can carry an SSH connection to a Codex process in a remote tmux
session. Register both ends while attaching the **local** pane:

```sh
rig attach --self --rig RIG --pod agents --member worker --runtime codex \
  --relay-ssh-host worker --relay-tmux-session wm-worker --json
```

This requires the patched CLI and daemon. The attachment remains `tmux`: messages
and captures still use the local pane. The returned `sessionName` is physical;
`senderAddress` and `env.OPENRIG_SESSION_NAME` are the supported routing identity.
Do not assume those strings are equal. WebMux consumes the returned address.

Create the remote session separately, then run this exact remote command through
SSH from the registered local pane (replace `wm-worker` with the registered name):

```sh
export PATH="$PATH:$HOME/.local/bin:/opt/homebrew/bin:/home/linuxbrew/.linuxbrew/bin"; exec tmux attach-session -t =wm-worker
```

The SSH destination must be the registered alias (optionally `user@alias`). Use
`-t` or `-tt`. Supported explicit options are BatchMode=yes,
StrictHostKeyChecking=yes, ConnectTimeout, ServerAliveInterval,
ServerAliveCountMax, ExitOnForwardFailure=yes, and loopback-only `-R`
forwards. Other command-line routing/configuration overrides are not proved by
this initial observer. Put the connection configuration in the existing SSH
configuration, which both the relay and observer use.

The daemon independently connects with BatchMode and strict host-key checking;
it never accepts a new host key or copies provider credentials. A probe has a
five-second deadline and an eight-MiB output bound. The remote login must provide
tmux and the C-locale `ps` fields used on macOS/Linux. Exactly one remote pane
across the selected session's windows is required.

Positive identity requires a unique foreground local SSH descendant with the
exact destination/attach command, a remote foreground Codex process descended
from that remote pane, and stable local and remote process/start-time identities
across two observations. The local pane/process and binding are rechecked after
remote observation. A disconnected transport, remote shell, changed process,
wrong target, missing observation, or ambiguous pane never supplies positive
proof. Existing Codex conversation-token checks still apply.

Relay metadata belongs to the binding and survives daemon restart. Rebinding the
transport clears it unless explicitly supplied again. This does not add remote
launch/resume/fork management, agent hooks, provider usage collection, remote
Claude support, or remote process control to OpenRig. WebMux owns its SSH session
launch; OpenRig observes identity and keeps its existing delivery policies.
