# OpenRig views in herdr-app

herdr-app (Herdr 2, the desktop app on herdr-core) can show OpenRig's terminal views inside its own window. A view
opens as a **Rig view**: an equal grid of the view's seats, each with a title row (`<agent> · <slice>`), padded to a
full grid. Rig views live in OpenRig's own herdr-app layout, **Rig** (`layouts/rig.json`), beside your tabs. A strip
above them switches between **Your tabs** and each view.

Nothing here needs a desktop display or SSH: the view opens in the herdr-app window the request came from.
herdr-app has to run on the same machine as the OpenRig daemon: OpenRig reaches it through its control socket
(`<app home>/herdr-app.sock`) and writes its mods and layout into that app home. An app on another machine, connected
to this machine's herdr-core over SSH, isn't supported.

## Set up

Nothing to install by hand: opening a view installs OpenRig's four mods (rig-strip, rig-cell-header, rig-pad,
rig-ended) and updates them when OpenRig is updated.

- The mods go to `<app home>/mods/rig-*`. The app home is herdr-app's own: `HERDR_APP_HOME`, else
  `$XDG_CONFIG_HOME/herdr-app`, else `~/.config/herdr-app`. `--app-home <dir>` on `rig terminal open` names another.
- OpenRig owns only the files it ships there (recorded in `<app home>/openrig/mods.json`). An update replaces those
  and nothing else in the folder. Mods you install yourself, from any source, are never touched.
- To move between a view's cells from the keyboard, bind the strip's actions in `keys.json`, section `layout:rig`
  (your agent can add it, as for any herdr-app key):
  `"layout:rig": { "alt-left": "rig-strip.left", "alt-right": "rig-strip.right", "alt-up": "rig-strip.up", "alt-down": "rig-strip.down" }`.
  In the Rig layout these replace herdr-app's `global` defaults for the same keys (`pane.go`, `agent.prev`/`agent.next`),
  which keep working on your other layouts. A key bound in `terminal` wins while a cell has focus, so pick keys that
  aren't bound there. Once you edit `keys.json`, herdr-app treats it as yours and stops adding new default shortcuts.
- An open never replaces a mod you changed: that folder stays as it is, the view opens anyway, and the open's notes
  name the folder and why. Only a mod a view needs that is missing and can't be installed stops an open.

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
   every tab (`hc run --bg --no-parent`, labelled `openrig.*`). A local viewer runs the view's tile for its seat, as in
   [terminal sessions](terminal-sessions.md): it shows the seat. An interactive cell starts with the read-only tile and
   takes no input until herdr-app has shown the view (step 3); then its writable tile takes over and attaches to the
   seat with plain tmux. A read-only cell only shows. A seat on another host opens as its own ssh attachment, writable
   or read-only as that view composes it. If the seat's session ends, the viewer says so and waits; it never leaves a
   shell in the cell.
2. One atomic write of `layouts/rig.json`: your current layout, with OpenRig's stack beside your tab block. Your own
   layout file is never written. A `rig.json` OpenRig didn't write is never overwritten.
3. The Rig layout is shown, the view is selected once herdr-app confirms it shows the new file, and the keyboard
   goes to the first live cell. Once herdr-app has acknowledged the layout with the view, OpenRig writes the gate file
   of each local interactive cell, on every page (including pages the strip hasn't shown yet, since the strip moves
   between pages on its own). These cells take input a fraction of a second later (they check every 0.2 s). Anything
   that reached a local interactive cell before that, typed or written to its terminal (`hc send`), is dropped, not
   delivered late. Remote cells run their ssh attachments from the start and don't wait for this gate. The open
   reports a view herdr-app hasn't confirmed as unconfirmed, not opened; its viewers keep running and it stays in the
   Rig layout, and its local interactive cells take input once herdr-app shows it. OpenRig keeps watching for 10
   minutes, across a daemon restart; if herdr-app hasn't shown it by then, each local interactive cell says so, takes
   no input, and names the command that opens the view again (`rig terminal open <view> --provider herdr-app`).

Other layouts and other herdr-app windows don't show Rig views. Each window (app home) has its own.

## The keyboard

- An open puts the keyboard on the new view's first live cell.
- Entering a view again (a click in the strip, or herdr-app restarting with it shown) returns the keyboard to the cell
  you were last in there, else the first live cell.
- **Your tabs** gives the keyboard back to your own pane.
- Apart from an open, OpenRig's own rewrites (another view closing, a cell ending) leave the keyboard where it is,
  whether you are in a view or in your tabs, with one exception: when the cell you were last in ends while its view is
  shown, the keyboard goes to that view's first live cell, if one is left.
- Once the view is shown, an interactive cell for a local seat attaches its tile to the seat with plain tmux, as a
  writable tile does ([terminal sessions](terminal-sessions.md#replacing-a-seats-session)). Until then it only shows
  the seat, and anything typed in it is dropped. A cell for a seat on another host is its ssh attachment from the
  start, so an interactive one takes input as soon as it runs. When the seat's session is replaced (a handover, a fresh
  launch, a restart), the tile follows the same seat to its new session, except an ssh tile on an isolated local tmux
  server ([terminal sessions](terminal-sessions.md#replacing-a-seats-session)).

## What OpenRig keeps in the app home

All under `<app home>/openrig/`:

| File | What it holds |
|---|---|
| `mods.json` | The files OpenRig shipped to `mods/rig-*`, so an update replaces only those. |
| `ack.json` | Written by the strip: the last layout revision herdr-app shows and the terminals it references. A viewer ends only once this shows its cell is gone. |
| `strip.json` | Written by the strip: the cell you were last in per view, and the view shown. herdr-app gives a mod new storage whenever its props change, which is every OpenRig write, so this is kept as a file. |

## Close a view

```sh
rig terminal close <rv-id> [--app-home <dir>]     # the id is in the open result's `space`
```

The view's cells leave `rig.json` first. A viewer ends only after herdr-app confirms it shows a layout without it, or
when the Rig layout isn't shown (herdr-app then reads the new file when it is). Only viewers OpenRig started (its
record, its labels and its exact command all match) are ended. Seats are never touched. Anything uncertain is left
running and named in the result.

If a viewer ends some other way (killed outside OpenRig, herdr-core restarted), OpenRig rewrites its cell as an
ended cell straight away. Views OpenRig recorded keep that owner across a daemon restart: when the daemon starts, it
reconciles each app home it has views in (a viewer that ended while it was down is rewritten then) and finishes any
pending ends. If `hc events` can't run (herdr-core missing or down), the watcher tries again after 5 s, then waits
twice as long each time, up to 5 minutes. Stopping the daemon ends only its own `hc events` watcher and timers; viewers
and views stay.

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

A status or a preview only reads: it starts no herdr-core process and creates nothing. OpenRig watches herdr-core's
events (`hc events`) and creates its viewers folder only when it opens or closes a view, or when it starts with views
already recorded.

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
