# Agent app presets

A community agent app runs in a seat from one YAML file, `$OPENRIG_HOME/agent-apps/<name>.yaml`, named by a rig
member's `runtime`. OpenRig hasn't tested these apps. `rig agent-app list` shows the installed presets, and
`rig ps --nodes` labels each seat with its maintainer, its declared limits and whether its preset declares resume.

## Format 1: launch only

```yaml
format: 1
name: my-app                # must equal the file name without .yaml
command: my-app --flag      # one program and its arguments; shell syntax makes the preset unusable
maintainer: Your Name
limits:                     # optional: what the app can't do, shown to people and agents
  - one turn per input line
```

A format-1 seat can't be resumed or forked. A restore without `--fresh` starts nothing for it and asks.

## Format 2: resume by session id

Format 2 adds an optional `session` block. With it, a snapshot records which of the app's sessions the seat
started, and `rig launch` (or a restore) continues that session instead of asking.

```yaml
format: 2
name: opencode
command: opencode
maintainer: Your Name
limits:
  - fork unsupported
session:
  id_pattern: '^ses_[A-Za-z0-9]{8,40}$'
  resume: [opencode, --session, '{session_id}']
  exists: [opencode, export, '{session_id}']
  list: [opencode, session, list, --format, json]
```

For OpenCode 2.0, use `opencode2` in place of `opencode` on every line.

- `id_pattern` (required): a regular expression anchored with `^` and `$`. OpenRig also requires an id to start with a
  letter or digit and hold at most 200 letters, digits, `.`, `_` or `-`, so it can never read as an option or a path.
  An id that fails either check is never put on a command line.
- `resume` (required): the command that opens the seat on a saved session. It's a list of arguments, not a shell
  line, and holds `{session_id}` as one whole element.
- `exists` (optional, recommended): run in the seat's directory before resuming. Exit 0 means the session exists, exit 1
  means it doesn't, and anything else means the app couldn't say. On exit 1 OpenRig starts nothing and asks, which
  matters for apps such as OpenCode 2.0 that open a blank session for an unknown id instead of failing. Its output is
  ignored.
- `list` (optional, needed for capture): run in the seat's directory; prints a JSON array of objects with a string
  `id`, a number `created` (milliseconds since the epoch) and, optionally, a string `directory`. OpenRig records a
  session only when exactly one listed session was created after the seat started, in the seat's directory, and isn't
  already recorded for another seat. When it can't tell, it records nothing and the seat stays as it was.

Commands run without a shell, with the daemon's environment, and time out after 60 seconds. Fork stays unsupported.
A session id is treated like a credential: OpenRig never prints it in an error.

Many apps create a session only when it receives its first message. A seat that never received one has nothing to
resume, and a restore asks as it does for format 1.
