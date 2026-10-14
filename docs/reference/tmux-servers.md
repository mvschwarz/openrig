# Choosing the tmux server for an OpenRig instance

`terminal.tmux_server` controls where the daemon creates and reads managed seats.
It accepts `inherit` (the default) or `isolated`. The environment override is
`OPENRIG_TMUX_SERVER`.

To keep managed seats out of your personal `tmux ls`, set this before starting a
new instance, or before a deliberate restart of an existing daemon:

```sh
rig config set terminal.tmux_server isolated
```

The setting is read once at daemon startup. Changing it does not move a running
seat. Inspect the effective choice with:

```sh
rig terminal status --json
```

The `tmux` object reports `requestedMode` (read at the last startup), effective
`mode`, `socketPath`, `serverArgs`, `migrationPending`, and `blockingSessions`.
The settings browser shows the configured value; terminal status shows what the
running daemon actually uses.

## Server identity and configuration

In `inherit` mode, a new instance uses the launching shell's `TMUX` socket, or the
default socket under `TMUX_TMPDIR` (otherwise `/tmp`) when outside tmux. Native
commands name that socket explicitly, so a new attaching terminal need not share
the daemon's environment.

In `isolated` mode, the socket is named `openrig-<hash>` under tmux's per-user
directory. The hash identifies the canonical `OPENRIG_HOME`: different homes get
different servers, and symlink aliases of one home share a server. Choose a short
`TMUX_TMPDIR` before the first isolated start if your normal temporary path would
exceed the platform's Unix socket path limit.

The daemon records the effective socket in `OPENRIG_HOME/tmux-server.json` using
an atomic, owner-only write. Keep this file and the durable
`tmux-server.initialized` marker with the instance state. A later shell
with different `TMUX` or `TMUX_TMPDIR` does not redirect an established isolated
instance. An invalid or unreadable record is reported rather than overwritten.
If the record disappears after selection, startup and `destroy --all` stop before
touching sessions. Restore the record from an instance backup, or inspect the
running daemon's `rig terminal status --json` to recover its effective selection.
Only an instance without either file retains the pre-selection fallback.

A newly started server loads tmux's normal system and user configuration,
including `~/.tmux.conf`; OpenRig does not substitute an empty configuration.
Existing OpenRig session options, such as `terminal.status_bar`, still apply.
An existing server does not reread its configuration merely because the daemon
restarts. Settings and sessions in a separate personal server are left alone.

## Existing teams and deferred migration

At startup, the daemon checks the previously selected server before switching.
If registered sessions still exist there, it keeps that server and reports a
pending migration. Explicit `OPENRIG_HOME` ownership markers distinguish another
instance's namesakes; unmarked legacy sessions are retained conservatively. If
the old server cannot be inspected, the daemon also keeps it and reports why.

Stop the listed sessions deliberately, then restart the daemon again to apply the
new selection. Merely editing the setting or waiting for the last seat to stop
does not switch a running daemon. The same rule applies when returning to
`inherit` or restarting an inherited instance from a different tmux server. No
live pane is moved, restarted or killed by server selection. Old viewing windows
can be closed separately after their conversations have stopped.

Bring a stopped team back with `rig up <name> --existing`. Its normal restoration
rules still apply: a seat without usable provider history requires an explicit
fresh-start choice before it launches.

On the first upgrade from a version without a socket record, the old-server
candidate comes from the launching environment. If live seats use a non-default
server, start the upgraded daemon from that original server to establish its
record, or stop those seats before changing servers. Earlier versions did not
persist enough information to find an arbitrary old socket from a different shell.

## Attachments, discovery and cleanup

`rig capture`, managed launch/stop/recovery, terminal previews and desktop viewers
use the effective server. `rig ps --nodes --json` includes `tmuxServerArgs` and a
matching `tmuxAttachCommand` for bound tmux seats. `rig tui --shared` uses that
metadata. To attach a terminal directly, use the canonical session name:

```sh
rig terminal attach '<session>'
rig terminal attach --read-only -- '<session>'
```

These commands attach on the daemon's machine. They do not create a seat or
switch somebody else's tmux client. A local CLI pointed at an HTTP remote daemon
cannot attach a same-named local session. Terminal attachment, shared TUI and
desktop windows compare the daemon's instance identity with the local durable
identity before using local terminal tools. A loopback URL through a port forward
does not bypass this check; use the matching `OPENRIG_HOME` on the daemon's machine.
SSH view tiles run `rig terminal attach`
on the remote host, using that host's local instance and socket; both the remote
CLI and daemon must support this command. The remote shell must select the right
`OPENRIG_HOME` when using a custom home. Local socket paths are never sent to it.

Discovery and adoption see the selected server. Existing sessions on another
server are not imported automatically. `rig attach --self` reports its current
socket and rejects a different server before binding or adding a node; an older
CLI without socket metadata must be updated to self-attach to an isolated
instance. A shell outside tmux can still attach as `external_cli`.

`rig destroy --all` reads the recorded effective server before stopping the daemon
or removing its state, and kills only the registered session names on that server.

Dedicated selection requires POSIX tmux. On Windows, psmux retains its existing
server behavior; requesting `isolated` produces a status note and a pending choice.
