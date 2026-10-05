# @openrig/tui — mission-control TUI

The explorer / master-detail "k9s for rigs" surface: left Explorer (Topology ·
Specs · Scopes · Terminals · Needs-You · System, Config and Connections, the
last three grouped as System; `src/sections.ts`), right content pane, top
command bar, ambient rig-stream footer. OBSERVE / NAVIGATE / DRIVE-STRUCTURE
only — ACT / PRODUCE / REVIEW-ARTIFACT surfaces live in Studio, not here. One
runtime dependency (`yaml`); it reads the daemon's EXISTING projections (two renderers, one projection —
`src/daemon-client.ts` is the entire HTTP surface).

## Run — one herdr tile, daemon-direct

From an installed CLI, `rig tui` opens mission control in the current terminal.
`rig tui --shared` joins the kernel's shared terminal instead (detach with
Ctrl-b d). The package's own bin is `openrig-tui` (`dist/main.js`).

The TUI runs as ONE pane/tile inside herdr's wall (any tmux pane works the
same way — the tile IS a tmux pane; no extra multiplexer, no integration
layer):

    # inside a herdr tile / tmux pane, daemon-direct (OPENRIG_URL or default):
    node packages/tui/dist/main.js --instance tui-1

    # options:
    #   --instance <id>   instance id (socket address; multi-instance ready)
    #   --url <daemon>    daemon base URL (default $OPENRIG_URL or http://127.0.0.1:7433)
    #   --socket <path>   control socket (default $OPENRIG_TUI_SOCKET or $OPENRIG_HOME/run/tui-<id>.sock)
    #   --demo            labeled demo fixture instead of live reads (never mixes with live)
    #   --no-color        plain text, no color

`rig terminal open <view>` opens every live agent in a view as terminal tiles
(herdr by default, or `--provider cmux`). The view is a rig name,
`mission:<id>`, `slice:<id>` or a saved-view id, not a command;
`rig terminal open kernel --provider herdr|cmux` opens the kernel's terminal.

## Driving it (human or agent — same grammar, same state)

Command bar / keyboard / mouse / control socket all mutate ONE view-state
through ONE path. Safe-core grammar: `:<section>` (any of the eight, e.g.
`:topology` `:needs`) · `/<filter>` · `host|rig|pod|agent|spec <name>` ·
`tab table|recent|overview|graph|health|topology|configuration|yaml|pulse` ·
`spec-of <agent>` · `running <spec>`. Keys: arrows + Enter navigate the
explorer, `f` toggles the footer, `q` quits.

In Scopes, select a mission or use `mission <name>`. Its workflow rows open the
current work, owner, recorded waiting reason, wake mechanism, next action and
bound sources. `workflow <instance-id>` and `packet <qitem-id>` address those
pages within the selected mission. Release ceremony, post-release housekeeping
and an authored successor remain separate. A receipt is an attributed record,
not an automatic acceptance verdict; bound source hashes describe compilation,
not an assertion that current source bytes are identical.

Specs separates authored declarations from observed consumers. Open a consumer
to inspect its served runtime and seat binding; missing source stays explicit.
The selected source is re-read on refresh even if the library revision did not
change. `back` or Escape returns to the previous selection, tab and scroll.
Escape first cancels command editing. On a spec detail page or an open file it
then goes back, and the list keeps its filter; elsewhere it clears an active
filter before going back. On long spec pages,
Up/Down scroll by default; Right enters links, then Up/Down and Enter follow them.
`rig tui commands --json` lists the shared command registry.

Agents: `tmux send-keys` of any command is the always-available floor; the
control socket is the addressable-screen API — one command per line, one JSON
reply per line, plus two read-only queries, `state` and `commands` (the command
registry with live availability):

    printf 'agent dev.impl\n' | nc -U ~/.openrig/run/tui-tui-1.sock

Socket rules (arch standing constraint): every socket command goes through the
one resolver/mutation path, and verbs stay OBSERVE/NAVIGATE/DRIVE-STRUCTURE
only. Unix-socket paths must stay under ~104 bytes (sun_path) — keep the
default runtime dir.

## Tests

    npm test          # vitest: grammar, state, parity (mouse/kbd/command), hydration
                      # fixtures, socket contract, §4.A route audit, --demo gate
