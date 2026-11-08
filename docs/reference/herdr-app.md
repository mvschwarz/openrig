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
  and nothing else in the folder. If you changed one of them, the install says so and leaves the mod as it is.
- `--keys` adds a `layout:rig` section to `keys.json`. Keys already bound there, in `terminal` (which wins while a
  cell has focus) or in `global` are left alone and named. herdr-app's own `global` defaults for these keys
  (`pane.go` on alt-left/right, `agent.prev`/`agent.next` on alt-up/down) are the exception: in the Rig layout the
  cell keys replace them, and they keep working on your other layouts. herdr-app then treats `keys.json` as yours: new default
  shortcuts in later releases are not added to it automatically. `rig herdr install --keys --remove` takes OpenRig's
  bindings out again; your file before the change is kept at `<app home>/openrig/keys.json.before-openrig`.
- Opening a view installs missing mods by itself. It never replaces a mod you changed.
- **A fuller mod suite** (a Rig sidebar, page, palette and menus, with richer view mods) can be installed instead of
  the four above: name its folder with `OPENRIG_HERDR_MODS_DIR` when you run `rig herdr install`. OpenRig records the
  folder in `<app home>/openrig/config.json` (`modsDir`), so later installs and the top-up when a view opens copy the
  same mods. A named or recorded folder that doesn't hold mods is reported, and nothing is changed.

## Open a view

- **From the TUI inside herdr-app:** Terminals, choose a view (Enter previews it), then **Open terminals**. The TUI
  recognises that it runs in a herdr-core terminal of a herdr-app window on this machine, and the preview and the
  open both use that window, so the plan you previewed is the one that opens. The preview says the view opens in
  this window; it shows no desktop or SSH recipe. A shared TUI viewed from a herdr-app terminal does the same. The
  kernel view opens in its narrow arrangement there (one seat per page): the window's width isn't the TUI's.
- **From a shell:** `--provider herdr-app` opens the view in the herdr-app window you run it in. Inside a herdr-app terminal, plain `rig terminal open <view>` does the same while that window is answering. `--window` always asks for a new desktop window.

  | Command | Where the view opens |
  |---|---|
  | `rig terminal open <view> --provider herdr-app [--app-home <dir>]` | In the herdr-app window this runs in (requires the window to answer). |
  | `rig terminal open <view>` | Inside an answering herdr-app terminal, in that herdr-app window; otherwise a desktop window. |
  | `rig terminal open <view> --window` | Always asks for a new desktop terminal window, even inside a herdr-app terminal. |

The herdr-app window must be answering on its socket (`<app home>/herdr-app.sock`); otherwise the open fails and says
so. Nothing falls back to a desktop window or an SSH recipe.

What an open does, in order:

1. Each viewer is recorded first (`$OPENRIG_HOME/private/herdr-app/clients/`), then started by herdr-core outside
   every tab (`hc run --bg --no-parent`, labelled `openrig.*`). A viewer attaches to its seat **read-only** and, if
   the seat's session ends, says so and waits; it never leaves a shell in the cell.
2. One atomic write of `layouts/rig.json`: your current layout, with OpenRig's stack beside your tab block. Your own
   layout file is never written. A `rig.json` OpenRig didn't write is never overwritten.
3. The Rig layout is shown, the view is selected once herdr-app confirms it shows the new file, and the keyboard
   goes to the first live cell. Only then do interactive seats' viewers become writable. A view herdr-app hasn't
   confirmed stays read-only.

Other layouts and other herdr-app windows don't show Rig views. Each window (app home) has its own.

## The keyboard

- An open puts the keyboard on the new view's first live cell.
- Entering a view again (a click in the strip, or herdr-app restarting with it shown) returns the keyboard to the cell
  you were last in there, else the first live cell.
- **Your tabs** gives the keyboard back to your own pane.
- OpenRig's own rewrites (another view opening or closing, a cell ending) never move the keyboard, whether you are in
  a view or in your tabs.

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

## Check

```sh
rig terminal status --provider herdr-app [--app-home <dir>]
```

`core` in the result names the herdr-core OpenRig starts and ends viewers in: the daemon's `HC_SESSION` (else
`default`) and `HC_SOCKET` if set. The herdr-app window must run on that same core. Terminal addresses are per core,
so a window on another core would show other terminals, or none, in the view's cells.

## Limits

- A Rig view is a layout inside herdr-app, not a herdr tab: other windows and other layouts don't show it.
- Following a task (`--follow`) isn't available in herdr-app yet.
- When a viewer ends unexpectedly, herdr-app removes its block and collapses the layout, which briefly opens the Files
  panel on that cell's folder until OpenRig's rewrite restores the layout. Viewers start in OpenRig's own empty
  folder (`$OPENRIG_HOME/private/herdr-app/viewers`). Planned closes never trigger this.
- OpenRig doesn't yet check that the window runs on the daemon's herdr-core (`core` in `rig terminal status`); it
  relies on both using the same session on the same machine.
- Runtime-tested on Linux only; macOS and Windows haven't been tried on real machines.
