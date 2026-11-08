# OpenRig views in herdr-app

herdr-app (Herdr 2, the desktop app on herdr-core) can show OpenRig's terminal views inside its own window. A view
opens as a **Rig view**: an equal grid of the view's seats, each with a title row (`<agent> · <slice>`), padded to a
full grid. Rig views live in OpenRig's own herdr-app layout, **Rig** (`layouts/rig.json`), beside your tabs. A strip
above them switches between **Your tabs** and each view.

Nothing here needs a desktop display or SSH: the view opens in the herdr-app window the request came from.

## Set up

```sh
rig herdr install            # OpenRig's mods: rig-strip, rig-cell-header, rig-pad, rig-ended
rig herdr install --keys     # optional: alt-arrows move between a view's cells
```

- The mods go to `<app home>/mods/rig-*`. The app home is herdr-app's own: `HERDR_APP_HOME`, else
  `$XDG_CONFIG_HOME/herdr-app`, else `~/.config/herdr-app`. `--app-home <dir>` names another.
- OpenRig owns only the files it ships there (recorded in `<app home>/openrig/mods.json`). An update replaces those
  and nothing else in the folder. If you changed one of them, the install says so and leaves the mod as it is. Mods you
  install yourself, from any source, are never touched.
- `--keys` adds a `layout:rig` section to `keys.json`. Keys already bound there, in `terminal` (which wins while a
  cell has focus) or in `global` are left alone and named. herdr-app's own `global` defaults for these keys
  (`pane.go` on alt-left/right, `agent.prev`/`agent.next` on alt-up/down) are the exception: in the Rig layout the
  cell keys replace them, and they keep working on your other layouts. herdr-app then treats `keys.json` as yours: new default
  shortcuts in later releases are not added to it automatically. `rig herdr install --keys --remove` takes OpenRig's
  bindings out again; your file before the change is kept at `<app home>/openrig/keys.json.before-openrig`.
- Opening a view installs missing mods and updates OpenRig's own by itself. It never replaces a mod you changed: that
  folder stays as it is, the view opens anyway, and the open's notes name the folder and why. Only a mod a view needs
  that is missing and can't be installed stops an open.

## Open a view

- **From the TUI inside herdr-app:** Terminals, choose a view (Enter previews it), then **Open terminals**. The TUI
  recognises that it runs in a herdr-core terminal of a herdr-app window on this machine, and the preview and the
  open both use that window, so the plan you previewed is the one that opens. The preview says the view opens in
  this window; it shows no desktop or SSH recipe. A shared TUI viewed from a herdr-app terminal does the same. The
  kernel view opens in its narrow arrangement there (one seat per page): the window's width isn't the TUI's.
- **From a shell:** `--provider herdr-app` opens the view in the herdr-app window you run it in. Inside a herdr-app terminal, plain `rig terminal open <view>` does the same when that window is answering. `--window` always asks for a new desktop window.

  | Command | Where the view opens |
  |---|---|
  | `rig terminal open <view> --provider herdr-app [--app-home <dir>]` | In the herdr-app window this runs in (requires the window to answer). |
  | `rig terminal open <view>` | Inside a herdr-app terminal when the window is answering, in that herdr-app window; otherwise a desktop window. |
  | `rig terminal open <view> --window` | Always asks for a new desktop terminal window, even inside a herdr-app terminal. |

The herdr-app window must be answering on its socket (`<app home>/herdr-app.sock`); otherwise an explicit open fails and says
so. Finding the socket file is how OpenRig guesses you are in a herdr-app window; whether the window is reachable is
checked by asking it. When a plain `rig terminal open <view>` in a herdr-app terminal finds that the socket does not
answer, it says so and opens a desktop window instead; `--provider herdr-app` never
falls back to a desktop window or an SSH recipe.

What an open does, in order:

1. Each viewer is recorded first (`$OPENRIG_HOME/private/herdr-app/clients/`), then started by herdr-core outside
   every tab (`hc run --bg --no-parent`, labelled `openrig.*`). An interactive local viewer attaches read-only and
   becomes writable when the view is revealed (read-only panes stay read-only); a seat on another host opens as its own
   ssh attachment, writable or read-only as that view composes it, and OpenRig doesn't hand over a keyboard for it. If
   the seat's session ends, the viewer says so and waits; it never leaves a shell in the cell.
2. One atomic write of `layouts/rig.json`: your current layout, with OpenRig's stack beside your tab block. Your own
   layout file is never written. A `rig.json` OpenRig didn't write is never overwritten.
3. The Rig layout is shown, the view is selected once herdr-app confirms it shows the new file, and the keyboard
   goes to the first live cell. Only then do local interactive seats' viewers become writable. A local viewer in a view
   herdr-app hasn't confirmed stays read-only until herdr-app shows it (OpenRig keeps watching for up to 10 minutes);
   then it becomes writable, and the view isn't selected for you. The open reports such a view's seats as unconfirmed,
   not opened; its viewers keep running and it stays in the Rig layout.

Other layouts and other herdr-app windows don't show Rig views. Each window (app home) has its own.

## The keyboard

- An open puts the keyboard on the new view's first live cell.
- Entering a view again (a click in the strip, or herdr-app restarting with it shown) returns the keyboard to the cell
  you were last in there, else the first live cell.
- **Your tabs** gives the keyboard back to your own pane.
- OpenRig's own rewrites (another view opening or closing, a cell ending) never move the keyboard, whether you are in
  a view or in your tabs.
- A writable viewer stays writable when its seat's session is replaced (a handover, a fresh launch, a restart): the
  viewer attaches to the new session, and OpenRig hands that viewer's own tmux client the keyboard again.

## What OpenRig keeps in the app home

All under `<app home>/openrig/`:

| File | What it holds |
|---|---|
| `mods.json` | The files OpenRig shipped to `mods/rig-*`, so an update replaces only those. |
| `ack.json` | Written by the strip: the last layout revision herdr-app shows and the terminals it references. A viewer ends only once this shows its cell is gone. |
| `strip.json` | Written by the strip: the cell you were last in per view, and the view shown. herdr-app gives a mod new storage whenever its props change, which is every OpenRig write, so this is kept as a file. |
| `keys.json.before-openrig` | Your `keys.json` before `rig herdr install --keys`. |

## Close a view

```sh
rig terminal close <rv-id> [--app-home <dir>]     # the id is in the open result's `space`
```

The view's cells leave `rig.json` first. A viewer ends only after herdr-app confirms it shows a layout without it, or
when the Rig layout isn't shown (herdr-app then reads the new file when it is). Only viewers OpenRig started (its
record, its labels and its exact command all match) are ended. Seats are never touched. Anything uncertain is left
running and named in the result.

If a viewer ends some other way (killed outside OpenRig, herdr-core restarted), OpenRig rewrites its cell as an
ended cell straight away.

## Which herdr-core

```sh
rig terminal status --provider herdr-app [--app-home <dir>]
```

`core` and `assumption` in the result name the herdr-core the daemon's `hc` runner starts and ends viewers in: the
daemon's `HC_SESSION` (else `default`) and `HC_SOCKET` if set when the daemon started. The herdr-app window must be a
client of that same core. Terminal addresses are per core, so a window attached to another core would show other
terminals, or none, in the view's cells. Open failures (`herdr_app_unavailable`, `viewer_start_failed`) and the note
when a window has not acknowledged a write also name the daemon's core (`HC_SESSION`/`HC_SOCKET`) so a mismatch is
visible straight away.

## Limits

- A Rig view is a layout inside herdr-app, not a herdr tab: other windows and other layouts don't show it.
- Following a task (`--follow`) isn't available in herdr-app yet.
- When a viewer ends unexpectedly, herdr-app removes its block and collapses the layout, which briefly opens the Files
  panel on that cell's folder until OpenRig's rewrite restores the layout. Viewers start in OpenRig's own empty
  folder (`$OPENRIG_HOME/private/herdr-app/viewers`). Planned closes never trigger this.
- OpenRig doesn't yet check that the window runs on the daemon's herdr-core (`core` in `rig terminal status`); it
  relies on both using the same session on the same machine.
- `POST /api/terminal/open` (and `POST /api/terminal/close`) carries no bearer middleware, matching the daemon's other
  open routes; an open writes `mods/rig-*`, `openrig/mods.json` and `layouts/rig.json` into the named `--app-home` once
  `herdr-app` answers a `status` request on `<app home>/herdr-app.sock`.
- Runtime-tested on Linux only; macOS and Windows haven't been tried on real machines.
