# Choose a Herdr session for a terminal view

Use `--session <name>` to open a view in a named Herdr session on the daemon's
host. For example, keep development and production rigs in separate sessions:

```sh
rig terminal open future-rig --provider herdr --session default --json
rig terminal open future-prod-rig --provider herdr --session future-prod --json
rig terminal status --provider herdr --session future-prod --json
```

The explicit provider form places the view in the existing Herdr session
without opening a desktop window. Use Herdr's own session management to prepare
the session. An unavailable selected session returns `herdr_unavailable`; it
does not redirect the view to a different session.

The `session` field in an open result confirms the requested selection. Status
also names the session and returns its resolved control socket in `status.launch`.
Session names are a single non-empty name, such as `future-prod`, rather than a
socket path. `--session default` explicitly selects Herdr's default session.

## Default selection and scope

With no `--session`, the daemon uses the Herdr endpoint selected when it started:
its `HERDR_SOCKET_PATH`, then its `HERDR_SESSION`, then the default endpoint.
Setting either variable only on a later `rig terminal open` command does not
change that daemon configuration. Pass `--session` for a per-command selection.

An explicit session resolves under the daemon user's Herdr session directory;
it takes precedence over that daemon's default socket override. The selection
belongs to the request. Saved views still describe membership and layout, so
pass `--session` again when reopening the view in that session.

The existing view rules apply: saved views, rig and pod views, read-only mission
and slice views, pagination, absent seats and partial results all use the same
composer. Selecting a session changes where those tiles are placed. It does
not relaunch the seats' tmux sessions or move queue ownership.

## Desktop windows and previews

```sh
rig terminal open future-prod-rig --session future-prod --window --json
```

The window launcher, readiness checks, workspace inventory, reuse and layout
application use the selected endpoint. When launched inside Herdr, the current
Herdr endpoint must match that selection to reuse the current terminal. To
place a view in another existing session from such a caller, use the explicit
`--provider herdr` form without `--window`.

Previews include the selected session in their fingerprint. A preview from one
session cannot authorize an open in another; refresh the preview after changing
the selection. The CLI asks the daemon to confirm named-session support before
requesting an open, so an older daemon cannot silently ignore the option and
write into its default session. An unconfirmed reply after an open is reported
as an unknown outcome; inspect the selected session before retrying.

`--session` applies to Herdr. A named session does not fall back to plain tmux
when Herdr is absent, and combining a session with cmux is rejected. Existing
workspaces are kept during reuse checks. Any suggested cleanup command for a
stale named-session workspace includes the selected socket.

## HTTP API

- `POST /api/terminal/open`: `{ view, provider?: "herdr", session?: string, expectedPlan?: string }`.
- `GET /api/terminal/preview?view=<view>&provider=herdr&session=<name>`.
- `GET /api/terminal/status?provider=herdr&session=<name>`.
- The alias `POST /api/rigs/:rigId/terminal/open` accepts the same session and
  preview binding, with the rig determining the view.

Malformed names and unsupported provider/session combinations return HTTP 400
before socket calls. A changed preview returns HTTP 409. An unavailable Herdr
session keeps the normal HTTP 200 provider result with `ok: false`, its selected
`session`, an error code and direct-attach guidance.
