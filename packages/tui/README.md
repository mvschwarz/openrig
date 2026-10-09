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
For “show me my agents” or the welcome screen, use
`rig terminal open saved:kernel --window` to open the dashboard and conversations
together. Only if that window cannot open, `rig tui --shared` is the dashboard-only
fallback (detach with Ctrl-b d). The package's own bin is `openrig-tui` (`dist/main.js`).

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

Inside an existing herdr or cmux workspace, `rig terminal open <view> --provider herdr`
(or `--provider cmux`) adds terminal tiles without opening a desktop window. The view
is a rig name, `mission:<id>`, `slice:<id>` or a saved-view id. For the first desktop
view, use `rig terminal open saved:kernel --window` as above.

In the TUI, choose **Open terminals** above a rig's grid or in an agent's detail.
The Terminals section also offers it after a passive view preview. It uses the
same desktop opener: herdr if installed, otherwise the composed layout in plain
tmux. Run the TUI on the selected daemon's desktop for this action. Headless or
remote sessions retain per-seat attach commands in the preview. A launch result
does not confirm visibility; check the new terminal shows the intended view.

## Driving it (human or agent — same grammar, same state)

Command bar / keyboard / mouse / control socket all mutate ONE view-state
through ONE path. Safe-core grammar: `:<section>` (any of the eight, e.g.
`:topology` `:needs`) · `/<filter>` · `host|rig|pod|agent|spec <name>` ·
`tab table|recent|overview|graph|health|topology|configuration|yaml|pulse` ·
`spec-of <agent>` · `running <spec>`. Keys: arrows + Enter navigate the
explorer, `F` toggles the footer, `q` quits.

In Scopes, select a mission or use `mission <name>`; with a mission selected, `M`
collapses its mini-requirements and `N` shows its narrative. Its workflow rows open the
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
During ordinary browsing, Escape clears typed command text first. With
history, it returns from a spec detail, an open file or an external link and
restores the previous filter; otherwise it closes an open health view, then
clears a filter, then goes back. On long spec pages,
Up/Down scroll by default; Right enters links, then Up/Down and Enter follow them.
`rig tui commands --json` lists the shared command registry.

Feed (`:feed`, also `:needs` or `:attention`) separates **Human requests** from
**Updates**. Open human-addressed FYIs now appear under Updates even without a
Slack receipt or human registration; previously only confirmed delivered FYIs
were shown. They carry **No action needed**, their priority, body and evidence.
Critical and urgent items precede routine items within each category. Requests
and open FYIs each have a 1000-item window, and the source footer reports a full
window as partial. Confirmed delivered FYIs retain their separate receipt history
after closure; an item visible in both sources appears once. If the queue source
is unavailable, an empty Updates section is marked unknown. Reading the feed
does not acknowledge an update, change its state or send it to Slack.

Agents: `tmux send-keys` of any command is the always-available floor; the
control socket is the addressable-screen API — one command per line, one JSON
reply per line, plus two read-only queries, `state` and `commands` (the command
registry with live availability):

    printf 'agent dev.impl\n' | nc -U ~/.openrig/run/tui-tui-1.sock

Terminals, Needs, System, Scopes, Config, Specs and file pages read no rigs. A
`host`, `rig`, `pod` or `agent` address sent from one switches to Topology and
resolves once that page's read settles. Until then the reply carries `resolving` and a `notice`; send `state`
for the result (the drill, or the error).

Socket rules (arch standing constraint): every socket command goes through the
one resolver/mutation path, and verbs stay OBSERVE/NAVIGATE/DRIVE-STRUCTURE
only. Unix-socket paths must stay under ~104 bytes (sun_path) — keep the
default runtime dir.

## Tests

    npm test          # vitest: grammar, state, parity (mouse/kbd/command), hydration
                      # fixtures, socket contract, §4.A route audit, --demo gate

The Feed regression tests in `packages/daemon/test/attention.test.ts` and
`test/feed-system.test.ts` cover undelivered FYIs, priority before the query limit,
unchanged queue state and decision filtering, receipt deduplication, narrow and
wide rendering, and an unavailable queue source. They use SQLite and local
HTTP/render fixtures, not a live Slack workspace or a provider session.
