# @openrig/tui — mission-control TUI

The explorer / master-detail "k9s for rigs" surface: left Explorer (Topology ·
Specs · Needs-You), right content pane, top command bar, ambient rig-stream
footer. OBSERVE / NAVIGATE / DRIVE-STRUCTURE only — ACT / PRODUCE /
REVIEW-ARTIFACT surfaces live in Studio, not here. Zero runtime dependencies;
it reads the daemon's EXISTING projections (two renderers, one projection —
`src/daemon-client.ts` is the entire HTTP surface).

## Run — one herdr tile, daemon-direct

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

An agent can compose a view and open it for the operator via the `rig
terminal` primitive pointing at that command.

## Driving it (human or agent — same grammar, same state)

Command bar / keyboard / mouse / control socket all mutate ONE view-state
through ONE path. Safe-core grammar: `:topology` `:specs` `:needs` ·
`/<filter>` · `host|rig|pod|agent|spec <name>` · `tab table|overview` ·
`spec-of <agent>` · `running <spec>`. Keys: arrows + Enter navigate the
explorer, `f` toggles the footer, `q` quits.

Agents: `tmux send-keys` of any command is the always-available floor; the
control socket is the addressable-screen API — one command per line, one JSON
reply per line, plus `state` for a read-only state query:

    printf 'agent dev.impl\n' | nc -U ~/.openrig/run/tui-tui-1.sock

Socket rules (arch standing constraint): every socket command goes through the
one resolver/mutation path, and verbs stay OBSERVE/NAVIGATE/DRIVE-STRUCTURE
only. Unix-socket paths must stay under ~104 bytes (sun_path) — keep the
default runtime dir.

## Tests

    npm test          # vitest: grammar, state, parity (mouse/kbd/command), hydration
                      # fixtures, socket contract, §4.A route audit, --demo gate
