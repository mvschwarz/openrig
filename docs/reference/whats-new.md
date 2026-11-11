# What changed in OpenRig 0.7.12

This note is for an agent on an install that was just upgraded to 0.7.12.
OpenRig 0.7.12 routes a person's typed, clicked or qualified answers with the
question to the configured receiving agent or the kernel operator to decide.
Answers wait when no receiver is available. Setup offers to register the person. `rig down` stops
only terminals it can show belong to the seat. It adds five database
migrations. If you upgraded from 0.7.10 or earlier, also read "What changed in
OpenRig 0.7.11" below, and so on back. For the full capability map, read
`rig context get onboarding-width/public-what-you-can-do.md`. After the upgraded
daemon starts, `rig context get reference/whats-new.md` describes this version.
Without a running daemon, read the packaged `daemon/docs/reference/whats-new.md`.

## After the upgrade

- **Back up the database, then restart the daemon.** Five migrations run on the
  daemon's first start: 155, 156 and 157 (queue erasure and its batches), 158
  (queue inbox check-ins) and 159 (an index for handed-off rows). If
  `$OPENRIG_DB` isn't backed up yet, copy that file (`rig config get db.path`
  shows it) with the daemon stopped, then `rig daemon start`. Going back to
  0.7.11 after these migrations isn't established.
- **New settings:** `retention.closed_content_days` (`0`, keeps closed work's
  content), `retention.closed_metadata_days` (`0`) and `retention.erasure_ledger`
  (empty, no ledger). Erasing closed work is opt-in. `rig config` shows each with
  its source.
- **The openrig-core plugin moves from 0.1.27 to 0.1.28.** Its activity relay
  and refocus hooks changed (with a new `refocus-state.cjs`), as did the
  agent-operated-software, claude-compaction-restore, openrig-user,
  retiring-and-inheriting-a-seat, seat-continuity-and-handover and
  session-compaction-and-restore skills. A Codex session kept running across the
  upgrade can ask for hook approval until it's relaunched.
- **`rig down` now leaves some terminals running.** It stops only a tmux session
  carrying the seat's own `OPENRIG_NODE_ID`, on the server and session it read.
  For a terminal OpenRig didn't create, a mismarked or replaced one, or a seat
  joined with `rig attach --self`, it exits 2 and names the terminal and how to
  stop it. Tell the person, and stop those by hand if they're theirs to stop.
  ([#2962](https://github.com/mvschwarz/openrig/pull/2962))

## Answers from a person reach an agent

- Answers nothing else reads, such as a host pairing request or a mode's
  scheduled end, use the configured receiving agent or the kernel operator.
  Answers wait when no receiver is available. ([#2923](https://github.com/mvschwarz/openrig/pull/2923))
- Pairing answers go to the receiving agent, and a person can decide directly in
  the TUI's pairing settings. ([#2931](https://github.com/mvschwarz/openrig/pull/2931), [#2935](https://github.com/mvschwarz/openrig/pull/2935))
- A runner's permission answer goes to the receiving agent, which decides while
  the runner waits, so a qualified answer ("only if it's the test file") is
  read before anything acts. ([#2934](https://github.com/mvschwarz/openrig/pull/2934))
- **What to do:** design for an agent to read the person's answer with its
  question and decide. If no receiver is available, say the answer is waiting;
  don't describe it as read or decided. Pairing settings in the TUI also offer
  the direct decision described above.

## Other changes to act on

- **Setup** offers to register the person, and a team started from the person's
  own assistant fits their logins, with a review before commit. ([#2924](https://github.com/mvschwarz/openrig/pull/2924), [#2905](https://github.com/mvschwarz/openrig/pull/2905))
- **Harnesses:** `protocol: pi-rpc`, launch wrappers in presets, and Pi
  cross-runtime switches. ([#2870](https://github.com/mvschwarz/openrig/pull/2870), [#2759](https://github.com/mvschwarz/openrig/pull/2759), [#2669](https://github.com/mvschwarz/openrig/pull/2669))
- **A relay connector** that can't accept incoming connections can pull
  (`OPENRIG_RELAY_MODE=pull` in the relay secrets file); push stays the default.
  ([#2844](https://github.com/mvschwarz/openrig/pull/2844))
- **herdr-app:** `rig terminal open <view> --provider herdr-app` opens a view in
  the herdr-app window. Following isn't claimed. ([#2744](https://github.com/mvschwarz/openrig/pull/2744))
- **Queue erasure** for closed-work retention and account deletion, off by
  default. ([#2837](https://github.com/mvschwarz/openrig/pull/2837), [#2843](https://github.com/mvschwarz/openrig/pull/2843))
- **Delivery evidence:** each send records one `transport.delivery_evidence`
  event. Read it as what was known about a delivery, not proof the agent read
  it. ([#2937](https://github.com/mvschwarz/openrig/pull/2937), [#2943](https://github.com/mvschwarz/openrig/pull/2943))
- **Seat self-knowledge:** managed guidance points to skills, help and project
  context; `rig seat status` shows when guidance was written relative to the session's recorded moments, and what the
  refocus hook recorded. ([#2918](https://github.com/mvschwarz/openrig/pull/2918), [#2920](https://github.com/mvschwarz/openrig/pull/2920), [#2916](https://github.com/mvschwarz/openrig/pull/2916))
- **Codex "Hooks need review" with smol-toml 1.9** is fixed; stop working around
  it by hand. ([#2804](https://github.com/mvschwarz/openrig/pull/2804))
- **A start reservation left after a reboot** is archived by `rig daemon start`;
  don't clear it by hand. ([#2915](https://github.com/mvschwarz/openrig/pull/2915))

## Limits to keep in view

- **Not in this release:** daemon pauses of up to about a second while reading
  proof on large mission trees ([#2970](https://github.com/mvschwarz/openrig/pull/2970)), and a delivery stall to a Claude seat
  showing Claude's auto-update failure footer ([#2948](https://github.com/mvschwarz/openrig/pull/2948)). Don't tell a person
  either is fixed.
- **`rig down`** keeps no stored host or boot identity, doesn't guard against
  another program running as the person, and a daemon restart between losing the
  tmux server and the stop wasn't exercised. For an adopted session, such as a
  seat joined with `rig attach --self`, `rig seat stop` still suggests
  `rig down`, which leaves that terminal running too. Release it with
  `rig unclaim <session>` (that leaves its process running), then close it in its
  own terminal. ([#2962](https://github.com/mvschwarz/openrig/pull/2962))
- **Codex working counter:** a capture that doesn't name its pane keeps the old
  comparison, and a restart that keeps the pane and its process id isn't seen.
  ([#2980](https://github.com/mvschwarz/openrig/pull/2980))
- **Custom blocker IDs** explain the wait but give no event wake; the timer
  remains. ([#2983](https://github.com/mvschwarz/openrig/pull/2983))
- **Runner permission answers:** a person's answer is kept, and an explicit
  decision works. In 0.7.12 the runner's confirmation updates fail to record, so
  no receipt or Feed confirmation appears, and the decision can reach the runner
  on its next read rather than at once (up to about 21 seconds in our test). To
  settle a request directly, run `rig seat decide-permission <request> --option <id>`.
  Pairing answers are separate, and their receipts are kept.
  ([#2934](https://github.com/mvschwarz/openrig/pull/2934))
- **0.7.11's limits below** still apply, except Codex hook setup with smol-toml
  1.9.x ([#2720](https://github.com/mvschwarz/openrig/issues/2720)), fixed by [#2804](https://github.com/mvschwarz/openrig/pull/2804).

## What changed in OpenRig 0.7.11

This note is for an agent on an install that was just upgraded to 0.7.11.
OpenRig 0.7.11 sends ordinary messages and work notices into a person's typed
draft by default instead of refusing them, lets a person reach the team from
their own coding agent (the `openrig` plugin) or an ACP app (`rig acp serve`),
holds a prepared managed compaction until the seat is idle, and clears a
restore that stopped at a prompt. On Linux, a daemon run as a systemd user
service keeps its seats when its unit restarts. It adds five database
migrations. On OpenShell 0.1.6 the worker's maintained cleanup now works, but
the worker still isn't end to end. If you upgraded
from 0.7.9 or earlier, also read "What changed in OpenRig 0.7.10" below, and
from 0.7.8 or earlier, "What changed in OpenRig 0.7.9" too. For the full
capability map, read `rig context get onboarding-width/public-what-you-can-do.md`.
After the upgraded daemon starts, `rig context get reference/whats-new.md`
describes this version. Without a running daemon, read the packaged
`daemon/docs/reference/whats-new.md`; `$OPENRIG_HOME/reference/whats-new.md` can
still be the previous copy until startup.

### After the upgrade

- **Back up the database, then restart the daemon.** Five migrations run on
  the daemon's first start: 150 (node launch wrapper), 151 (Pi account
  switches), 152 (workflow instance spec), 153 (events retention marks) and 154
  (workflow instance root objective). If `$OPENRIG_DB` isn't backed up yet,
  copy that file (`rig config get db.path` shows it) with the daemon stopped,
  then `rig daemon start`. Going back to 0.7.10 after these migrations isn't
  established.
- **New settings:** `transport.draft_delivery` (`deliver`), `acp.to` (empty),
  `daemon.seat_poll_interval_ms` (1000) and `retention.events_days` (`0`, keeps
  every event). `rig config` shows each with its source.
- **The openrig-core plugin moves from 0.1.26 to 0.1.27.**
  Its activity relay and refocus hooks changed, as did the refocusing,
  openrig-user and openrig-skills skills. Managed refresh preserves replaced
  files under `$OPENRIG_HOME/backups/managed-refresh/<id>/`; reapply local edits
  you still need from the preserved copy.
- **Linux, with the daemon as a systemd user service:** the seats move into
  their own scope only when their tmux server next starts fresh; until then,
  stopping or restarting the daemon's unit still takes them down.
- **Tell the person sends now join their drafts** (below). To keep the refusal,
  run `rig config set transport.draft_delivery refuse`; it applies from the
  next send, with no restart.
- **Pi seats:** a Pi seat that declares an absolute `PI_CODING_AGENT_DIR` in its
  `env:` now uses it as its account home and needs a readable `auth.json`
  there, or the launch stops. Prepare one, or remove the declaration to keep
  the managed seat login. Ask the person before changing their spec.
- **herdr-core terminals:** new starts no longer inherit `HC_SCOPE`,
  `HC_TERMINAL_ID` or `HC_TERMINAL_SOCKET`; a daemon or tmux server already
  running with them keeps them until it's restarted.
- **Claude seats that load openrig-core themselves** lose OpenRig's unchanged
  copies of its skills at their next launch, so each skill loads once; the
  launch result warns with the copies removed or kept.

### Sends and drafts

- **Under `deliver` (the default),** an ordinary `rig send` or work notice to a
  seat whose prompt holds a person's typed draft pastes the message at the
  cursor and submits the combined input as one prompt. The result says whether
  submission was confirmed and, when OpenRig saw the draft, that it joined it.
  An unset, unreadable or invalid value follows `deliver`.
- **Still refused or held under either value:** menus, permission prompts, a
  seat's typing guard (`draft-aware`, `hold`), managed compaction's sends and
  `--wait-for-idle`.
- **Under `refuse`,** a send is refused, and a work notice retried once the
  prompt is clear, where OpenRig detects the draft. Claude Code and Codex sends
  now also read the input box before pasting, so a draft only the box shows
  refuses too (`target_needs_input` / `prompt_draft`).
- **The draft-aware typing guard** reads a Claude composer with a statusLine or
  the background task panel, and Claude Code 2.1.319's bare
  `✔ Update installed · Restart to update` row in a narrow pane, so an empty box
  gets the wake instead of `draft_input_unknown`.
- **Held messages coalesce:** a sender's newest held message at a seat retires
  its earlier ones. Read them with `rig seat held-messages <seat>` (each with
  `--id <id>`); an older backlog clears at that sender's next held message or
  with `rig seat retire-held-message`.
- **Stopped seats aren't woken at each daemon start:** their rows stay owed, and
  the start-up log says `waiting=N (not replayed: …)`. That isn't delivery.

### Compaction, restore and handover

- **A prepared managed compaction is held, not re-requested.** When the map is
  complete but `/compact` couldn't go in, the attempt stays `waiting`, marked
  `prepared`, and sends `/compact` at the next idle moment with an empty box.
  `rig compact <seat> --state` shows it; a manual `rig compact` reads
  `already_in_progress`; `--cancel` disarms it. It ends on a context dip, a
  conversation change, a stale map (`prepared_map_stale`: 15 points of growth or
  2 hours) or a map that stops reading ready.
- **The final `/compact` waits out the preparation's own fresh activity** (up
  to about 23 s, against 9 s), so an idle seat that ran out of context compacts
  instead of being refused; a busy seat can wait up to about 14 s longer.
- **A queue wake refused at a prompt** no longer goes in right after
  "Compacted" while the compaction still owes its turn boundary and restore
  request; it goes in at the next idle moment after that step clears.
- **A full restore stopped at a prompt clears itself** once the seat runs the
  conversation it was restoring. If a seat still reads `attention_required`, run
  `rig seat clear-attention <seat>`, with `--reason` after a partial restore or
  a community harness's assisted startup. `proof_superseded` means the restore
  changed mid-check.
- **A Codex helper inside a Claude seat** no longer takes the seat's resume
  token (`transcript_not_this_session`).
- **A Claude rebuild handover may report its priming packet unconfirmed.**
  Submit the existing packet once, only if it's still staged. Never resend it
  blindly or rerun the handover.
- **`on_restore: follow_source`** on a spec's `resources.skills[]` entry
  refreshes that skill from its source on restore; `keep_saved` is the default.

### Working with the team from outside

- **The `openrig` plugin** lets a person use their own Claude Code or Codex
  with their local team: hand it work, follow it, answer the team's questions
  in their own words, and read the result. Install it from the package
  (`claude plugin marketplace add "$(npm root -g)/@openrig/cli/daemon/assets/plugins/openrig"`,
  then `claude plugin install openrig@openrig-app`) or from this repository on
  GitHub. Everyone using the app on a machine acts as the seat it names.
- **VS Code, Copilot CLI and Cursor** start its server with no seat: add your
  own `rig mcp serve --front-door` server with `OPENRIG_SESSION_NAME` set and
  turn the plugin's off. A seatless app can create tasks, send and post as
  `unknown-mcp-<8 hex>`, but can't claim, update, hand off or answer.
- **ACP apps:** `rig acp serve --to <member@rig>` (or the `acp.to` setting)
  makes the team an agent in an app that launches a custom ACP agent, such as
  Zed or T3 Code. Nothing runs until an app starts it, and it uses the daemon
  `rig` uses. A question left unanswered in the app stays open in the TUI and
  Slack. The `@openrig/acp` launcher is packed beside the CLI at the same
  version. See `docs/reference/acp-agents.md`.
- **Assistants through a grant service** are experimental, unsupported and off
  by default: they need your own internet-reachable `rig mcp serve --http
  --grant-service <url>` and an outside grant service. A registered person can
  answer the team's questions from one, and `--task-destination <member@rig>`
  names where its tasks go (`docs/reference/hosted-members.md`).
- **The `relay` gateway connector** is off unless you add a relay binding. It
  hands questions and updates to a bridge the operator runs on loopback;
  "Accepted by bridge" isn't delivery (`docs/reference/gateway-relay.md`).

### OpenShell workers

On OpenShell 0.1.6 the maintained cleanup (`delete-owned`) now works for a
custom image, and recreate and an exact resume passed in our native run. A
restored guest still receives its startup text again, so strict recall after a
restore isn't met, and the worker isn't end to end. The CA fix holds on 0.1.6.
"Never grant the guest access to the daemon's main API
port (normally 7433)."

### Other changes to act on

- Denying or dropping a host pairing request in Steering now gives the requesting machine no access; in 0.7.9 and 0.7.10, that action could return the daemon access token. ([#2884](https://github.com/mvschwarz/openrig/pull/2884))
- **Pairing answers now reach the target's kernel operator.** On a 0.7.11 target with a receiving kernel operator, typed words and Approve or Deny choices in the TUI, Steering or Slack are replies for that agent to read. Receiving a reply neither grants nor denies access. The operator acts on clear intent with `rig host approve <code>` or `rig host deny <code>` and asks back when the answer is unclear. The commands also work from a plain terminal on the target; they use its operator bearer (`OPENRIG_AUTH_BEARER_TOKEN`, or `--bearer <token>`). ([#2900](https://github.com/mvschwarz/openrig/pull/2900))
- **An Approve click on an operator-owned request waits for the operator to act.** A stopped operator keeps ownership; the answer waits in its queue. A stopped or unknown running state is named with the terminal route, without claiming the answer was read. If there is no operator, it cannot receive answers, or OpenRig cannot determine one, the request names that case and uses the agent-free path: Approve and Deny decide directly, and replies lead to another ask rather than denial. File-only replies and the literal `[file reply]` have no words stored on the agent-free ask; they still do not deny it.
- **TUI answers use the daemon's operator bearer when configured.** Ordinary terminal calls keep their separate terminal credential. A missing or wrong action credential leaves the answer unrecorded and shows what to set; this does not weaken the daemon's authentication.
- **Receipt, clarification and outcome are separate steps.** Receipts, agent-free re-asks and outcomes inferred from clicks or closes need the requesting machine to keep polling. An explicit `rig host approve` or `rig host deny` attempts its outcome update directly. An expiry timer closes the ask even if polling stopped; an unanswered expired ask gets no further update. Requests and decisions live in daemon memory, so a restart drops an open request. Approval still must be collected before expiry. This target-side change does not change older targets.

- **Rows on another host:** `rig queue show`, `list`, `transitions`, `update`
  and `block` take `--host <id>`; `claim` doesn't, since only the destination
  seat on its own host claims. `--host` never follows `rig host select`.
- **A seat's unclaimed backlog:** a seat with no escalation route or delegation
  parent gets one `unclaimed-backlog` notice. To route its findings to a
  watching seat:
  `rig edge add <rig> <root seat's logical id> <watching seat> --kind escalates_to`.
- **Claims read `working`** for up to 60 minutes while a Claude owner has a
  live background shell, and 20 while a managed restore is owed.
- **A cross-host handoff that overrides your claim** wakes you with the
  successor's id: stop and coordinate with that seat.
- **Code results:** set an `openrig.code-result/v1` manifest as `evidenceRef`;
  `rig queue artifact <qitemId>` and `rig_artifact_read` return the commit pair.
- **Workflows:** runs keep their own spec; `rig workflow unregister
  <name>[@<version>]` (or `--prune-missing`) removes registered versions;
  `rig workflow trace <id> --full` returns the whole trail; `show`, `trace` and
  `status` print `objective:`.
- **`rig stream emit` timeouts:** repeat with the same `--id`, or check with
  `rig stream list` before emitting again.
- **Launch and setup:** `launch_wrapper` works for local Claude Code, Pi and
  Codex seats; `rig provider switch --seat <pi seat> --to-account <name>
  --account-home <dir> --reason "<why>"` switches a Pi seat's account (`--dry-run`
  first), and a Pi seat with a declared account home starts again; `rig config set` says when
  an environment variable masks the saved value.
- **Linux seats:** when the daemon runs as a systemd user service, the seats'
  tmux server starts in its own user scope (`openrig-tmux-<id>.scope`), so the
  daemon's unit can stop or restart without ending them. Otherwise the server
  starts as before, with one log line giving the reason.
- **Writable terminal tiles** attach as in 0.7.10: the screen in use sizes the
  seat and text reflows on resize. Read-only tiles keep showing without attaching
  or resizing the seat. Web fixed geometry is opt-in through
  `terminal.fixed_geometry` (off by default). As in 0.7.10, Enter or Ctrl-C while
  the first attach is in flight can close that viewer; the agent keeps running,
  so reopen the view. Kept writable tiles from 0.7.8, 0.7.9 or pre-reflow 0.7.11
  need a manual refresh: close only the owned viewer and reopen with
  `rig terminal open`; for `--follow`, use `--no-follow` first, then open a fresh
  view. The agent and conversation are preserved; no automatic migration runs.
  ([#2868](https://github.com/mvschwarz/openrig/pull/2868), [#2757](https://github.com/mvschwarz/openrig/pull/2757), [#2821](https://github.com/mvschwarz/openrig/pull/2821))
- **A Claude seat launched with `--settings` JSON written with spaces** can be
  verified again.
- **`view.changed` is no longer stored,** and `/api/events` no longer sends it.
- **Old history-only events can be pruned, if you choose to.** `retention.events_days` (default `0`, which keeps every
  event) turns on a pass in the retention sweep (at daemon start and daily) that deletes `view.changed`,
  `snapshot.created`, `watchdog.evaluation_fired` and the `queue.created`, `queue.updated`, `queue.claimed`,
  `queue.unclaimed` and `queue.handed_off` events older than that many days; 14 is a reasonable value
  (`rig config set retention.events_days 14`). Every other type is kept at any age, because restore, startup proof and
  the seat readers fold from them, and the newest event is always kept. What you give up: pruned events no longer
  replay from `/api/events` (an older cursor or a large `?replay`), no longer appear in `rig telemetry events` (which
  reports the gap) or in older log and feed entries, and a later change of the setting can't bring them back. A new
  value is read at the next sweep: the daily one, or the next daemon start. The first sweep after turning it on works
  through the old history in short steps while the daemon keeps answering. `retention.enabled false` stops every
  retention pass from the next daemon start.
- **The database file does not shrink by itself.** Pruned rows free pages that new events reuse, which slows the file's
  growth; other tables still grow. To give the space back to the disk: find the file with `rig config get db.path`, stop the daemon
  (`rig daemon stop`), copy the file aside, run `sqlite3 <that file> "VACUUM;"` (it needs free disk about the size of
  the file and can take a few minutes), then `rig daemon start`. Never vacuum the file of a running daemon.
- **With pruning on, `rig telemetry events` reports the pruned ranges.** A page that spans pruned events inside the
  retained window has a `retained_sequence_gap` for each missing seq range and `coverage.status` `partial` (it used to be
  `retained_window`); events pruned from the start of the log show up as `before_retained_floor`.
- **Large fleets:** `daemon.seat_poll_interval_ms` (up to 2000) lowers CPU at
  the cost of activity freshness; keep 1000 if tmux is slow.
- **Terminals:** Herdr follow views work on macOS (protocol 22) and open a
  snapshot (`follow_unsupported`) where live following isn't supported.

### Limits to keep in view

- **OpenShell:** a restored guest gets its startup text again, strict recall
  isn't met, and the worker isn't end to end (above).
- **Drafts:** detection isn't complete. Under `refuse`, an unreadable input box
  lets the send go ahead; under `deliver`, a result may not mention a draft.
- **A post-compaction step can still hold** when the box reads as typed, under
  draft-aware delivery or the typing guard, or after a lost `/compact`. Run
  `rig compact <seat> --cancel`, then send a restore request naming the newest
  restore map, marker and packet. A refused queue wake now waits for that step,
  but recovery at daemon start and a new handoff's wake don't check yet.
- **`keep_saved` skills:** a skill whose source changes between `rig down` and
  the restore comes back missing, named in the restore's warnings; an edited seat
  copy is kept.
- **Terminal tiles** each run one tmux command a second while showing (8 tiles
  used about 6–8% of one core on an Apple Silicon Mac mini).
- **A message held as `draft_input_unknown`** isn't retried, and whether
  managed compaction gets past the update banner wasn't retested.
- **Claude provider switch:** the "probe pane returned to a shell" failure in
  [#2341](https://github.com/mvschwarz/openrig/issues/2341) isn't shown fixed;
  the launcher-script rebuild timeout and `--no-chrome` are fixed.
- **ACP apps** were checked in T3 Code (Beta) 0.1.7 and with a scripted client;
  the unanswered-question notice hasn't run in a live app. A cancel stops
  waiting; the team's work carries on.
- **The `openrig` plugin** hasn't run in Claude Desktop, the Codex app or
  Copilot CLI. **Grant-service assistants** still aren't woken.
- **Claude `launch_wrapper`** hasn't run with zsh, on macOS arm64 or with a real
  installed Claude; an alias or shell function named `claude` fails closed.
- **Going back to 0.7.10** isn't established; an older permission hook also
  gives named-policy Claude sessions no decision until they're relaunched.
- **The other 0.7.10 limits below still apply:** `rig exec` cancels,
  permission requests in seat status, Codex hooks (including
  `rig seat restart --keep-conversation` refusing a Codex seat launched with
  developer instructions), smol-toml 1.9.x, Slack, Claude Code 2.1.319's auto
  mode, Codex snapshot restores and `AGENTS.md`, unretried reminders, SSH host
  status, advisories on a native resume, seats handed over before 0.7.9, `rig`
  in the TUI's shell after a project-local install, the "Startup prompt still
  staged" message, and a partial install from two npm installs at once.
  0.7.10's bare-banner and launcher-script limits are fixed, and its OpenShell
  limit is replaced by the one above.

---

## What changed in OpenRig 0.7.10

The changes from 0.7.9 to 0.7.10, published on 2026-11-08, for an install
upgrading from 0.7.9 or earlier. 0.7.10 added `rig exec` for finite runs on
Claude Code or Codex, sent a held post-compaction step after two idle polls that
can't read the input box, left every tmux mode before a delivery, and showed
agent spec advisories at launch. Its OpenShell line below is corrected.

### After the upgrade

- **Restart the daemon** to load the new code: `rig daemon stop`, then
  `rig daemon start`. This release adds no migrations.
- **The bundled openrig-core plugin goes from 0.1.25 to 0.1.26.** Its Claude
  hooks add a `PermissionRequest` hook that reports permission requests to seat
  status, and its refocus hook and the refocusing skill's trace script changed.
  Managed refresh preserves replaced files under
  `$OPENRIG_HOME/backups/managed-refresh/<id>/`; reapply local edits you still
  need from the preserved copy.
- **Check agent specs before relaunching seats:** run `rig agent validate <path>`
  and read any `agent spec advisory` line. A profile's `uses.<category>` written
  as a single value now selects that resource; if the resource pool doesn't hold
  it, a member using that profile fails to resolve with "not found in resource
  pool". Ask the person before you change their spec.
- **Codex hooks:** a Codex seat kept running across the upgrade can show "Hook
  failed — plugin contents changed; hook approval required" until relaunched; in
  0.7.9's upgrade test, one seat restarted with OpenRig's managed restart showed
  no review afterwards.
- **OpenShell:** rebuild a guest image with this release's `guest.py` before
  using it; the CA repair is in that file, which the image carries.
- **Codex tool commands use a non-login shell:** managed Codex seats now pass
  Codex `-c allow_login_shell=false`, so plain `rig` works however OpenRig was
  installed, with a Codex that supports `allow_login_shell` (checked in Codex's
  source at 0.162.1 and 0.166); not yet run with a live Codex seat. Setup that lives only in login or rc files, and shell functions and
  aliases, may be missing from tool commands, and a model request for
  `login: true` gets Codex's refusal, "login shell is disabled by config". To
  defer to Codex's own setting, run `rig config set launch.codex_login_shell
  true`; a login file that sets `PATH` outright can then hide `rig`. It applies
  at each seat's next launch, and a restart in place keeps the running choice.
  ([#2613](https://github.com/mvschwarz/openrig/pull/2613))

### Finite runs: `rig exec`

`docs/reference/acp-agents.md` is the rule. Read it before handing a row to
Claude Code or Codex.
- **Install the adapters first:** `@agentclientprotocol/claude-agent-acp`
  0.101.0 and `@agentclientprotocol/codex-acp` 2.5.0, as that page shows.
  `rig exec harnesses` reports the adapter and native versions it finds.
- **Run:** `rig exec run <row> --harness claude` (or `codex`). `--plan` shows
  what would run and starts nothing; `--wait` waits for the outcome. A connector
  owns the run, so leaving `--wait` or closing the terminal doesn't stop it.
  Running it again returns the row's run instead of sending the task twice;
  `--again` starts another turn once that run has ended.
- **Read the outcome** with `rig exec status <runId|row>`. `interrupted` means
  the connector died without recording an outcome, so the outcome is unknown. A
  `completed` turn is the agent's report, not finished work: check the work
  before you close the row. `--wait` exits 0 for `completed`, 2 for any other
  outcome and 3 when you stop waiting.
- **Cancel** with `rig exec cancel <runId>`, not `rig acp cancel`. An
  acknowledgement isn't a settled shutdown, and it says nothing about further
  spend.
- **Usage and cost** the agent reported are on the row's outcome note, for
  `rig acp run` too, each with its source; what it didn't report reads unknown.

### Compaction and delivery

- **A held post-compaction step goes in.** After two idle polls in a row that
  can't read a seat's input box, the next poll sends the step (the turn
  boundary, the restore request or the audit). `rig compact <seat> --state` and
  `rig seat status` say it went in over a box OpenRig couldn't read; they never
  call that box empty. A draft OpenRig can't recognise in that box may receive
  the restore text.
- **Still held:** a box that reads as typed, with or without a suggestion; a
  seat whose draft-aware delivery or typing guard holds OpenRig's input; and the
  step after a `/compact` whose result was lost. To take over a held restore by
  hand, run `rig compact <seat> --cancel`, then send the seat a restore request
  naming its newest restore map, its restore marker and its packet. A step
  already being pasted can still land.
- **tmux modes:** a send or wake now leaves every tmux mode in a seat's pane,
  including a chooser, customize or clock mode a person has open. If a send is
  still refused for a tmux mode, the refusal names why leaving failed.
- **A scrolled pane with a stale record:** leaving the mode now goes through the
  seat's address, so a stale binding naming the same reused tmux pane, from
  another rig for example, no longer makes the send fail with nothing sent.
- **Herdr views kept across an upgrade keep working,** on Linux Herdr 0.9.5 /
  protocol 22. A viewer or follow view kept from 0.7.5 through 0.7.9 now counts
  as the same attachment when only OpenRig's tile script changed, and moves to
  the current command, so the viewer stays confirmed and the follow view goes on
  adding and closing tiles. A kept viewer that's already running keeps its
  earlier sizing for as long as it runs, its own re-attaches included; writable
  viewers opened after the upgrade size their pane. A different session, tmux,
  server or read-only setting still holds the view, as before. Checked against
  the scripts those releases used, not yet with a live Herdr. It follows
  @natefaerber's approach in
  [#2467](https://github.com/mvschwarz/openrig/pull/2467). ([#2634](https://github.com/mvschwarz/openrig/pull/2634))

### OpenShell workers

0.7.10 fixes, in the source, the two problems that stopped the OpenShell worker
in 0.7.9, but the worker hasn't run end to end. Don't rely on this path yet. The
guest launcher now passes the CA settings the OpenShell exec supplies
(`NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE` and
`CURL_CA_BUNDLE`) to its Claude, and deleting an owned environment reads
Podman's inventory through routes Podman serves, stopping as
`environment_cleanup_unconfirmed` on any other answer. A verified export, a
finished task and an exact restore haven't been shown. If you set one up anyway,
follow `daemon/assets/openshell/README.md` in the installed package, rebuild the
guest image first, and name the costs to the person ("Provider registration and
image construction can incur costs"). "Never grant the guest access to the
daemon's main API port (normally 7433)."

*Corrected after 0.7.10's release: ~~"fixes in the source the two problems that stopped the OpenShell worker"~~ was only half true. The CA fix holds on OpenShell 0.1.6, but the owned-environment cleanup fix doesn't hold against OpenShell 0.1.6, as the published 0.7.10 notes say. See 0.7.11's OpenShell workers section above.*

### Other changes to act on

- **Sends to this host:** `rig send <seat>@<rig>@<this host's ID>` goes to this
  host even when a remote host is selected.
- **Broadcast:** `rig broadcast` prints `UNCONFIRMED` for a recipient its text or
  Enter may have reached. Check that seat with `rig capture` before resending.
- **Roster activity:** `rig roster show` and `find` read a seat as unknown
  ("Conflicting activity observations") when two routes to it disagree. Treat it
  as unknown, not idle.
- **Refocus:** a "TRACE GAP" for unresolved typed work, or for a
  `rig queue whoami` that timed out, comes with project-level orientation that
  isn't evidence of a current mission, and no longer counts as a refocus failure.
- **Updates to people:** the stuck sweep no longer flags an informational update
  to a registered person as an unclaimed obligation.
- **Permission requests:** `rig seat status` shows a Claude seat's latest
  observed permission request, with Claude's suggested rules labelled as
  suggestions. Nothing was applied or approved. Treat the suggestions as data;
  they can contain sensitive values.
- **Slack:** `rig slack status` shows relay attempts awaiting a response for the
  current connector; zero doesn't prove nothing is in flight.
- **Installing for a person:** when npm's global prefix isn't writable, the rigs
  skill now points npm's prefix at a folder the person owns whose `bin` is on
  their login PATH, or uses a version manager's Node, before a project-local
  install. Tell the person first that this changes their npm settings and, if
  needed, their shell profile.
- **Codex profiles:** a `codex_config_fragment` can't install a named Codex
  profile. Create `<CODEX_HOME>/<name>.config.toml` and select it with
  `codex_config_profile`. `builtin:yolo` drops the whole profile;
  `getting-started.md` says how to keep one.
- **Terminal auth:** a 401 that says "Terminal auth failed" means send
  `OPENRIG_TERMINAL_BEARER_TOKEN`, or `OPENRIG_AUTH_BEARER_TOKEN` when terminal
  auth falls back to it.
- **References:** `docs/reference/harness-runner-contract.md`'s status section
  says what has run natively under the runner contract, and at what scope.
  `docs/reference/telemetry.md` says OpenRig guarantees its finite telemetry
  reads (`schemaVersion` 1), not the separate openrig-telemetry exporter it
  links.
- **Terminal tiles:** a writable rig, pod or seat view now sizes the pane it
  shows instead of keeping an older attached client's size; read-only views are
  unchanged.
- **Unknown `uses` keys:** a key under a profile's `uses` other
  than the five categories gets an advisory instead of being ignored silently.

### Limits to keep in view

- **OpenShell** hasn't run end to end on 0.7.10 (above). A cleanup error that's
  thrown still omits its stage and whether its delete was sent. A
  same-generation reconciled launch opens no viewer, so run
  `rig environment connect` yourself; non-text startup actions aren't supported
  on environment seats.
- **`rig exec`:** no real adapter has run under it yet; one run per row,
  detached ownership and reconciling were checked against a stand-in agent.
  Concurrent runs, long or background tasks, recovery across a reboot, MCP
  servers and Windows aren't covered. A Ctrl-C just before the connector is
  launched isn't caught by `--wait`.
- **Draft-aware delivery to Claude:** a narrow Claude pane showing
  `✔ Update installed · Restart to update` on its own line can still hold
  deliveries at an empty prompt, queue wakes included; 0.7.10 doesn't recognize
  that bare banner. A held message isn't replayed automatically by that path.
- **Seats handed over before 0.7.9** keep their adopted origin until a later
  launched handover or managed launch records a new session. Until then
  `rig seat stop`, `clean` and in-place restart refuse them, and now say why.
  Don't use `rig unclaim` to get around it: that ends OpenRig's management of
  the seat.
- **Permission requests in seat status** show only the latest one, held in
  memory for five minutes and lost on a daemon restart.
- **Agent spec advisories** don't show for a native resume that continues a
  saved conversation.
- **The other 0.7.9 limits below still apply:** open updates for a person, Slack,
  SSH host status, shared asks, permit records, existing seats, Codex hooks, and
  grant-service assistants not being woken. 0.7.9's limits on a restore request
  held after compaction, `rig broadcast`'s `FAILED`, what has run under the
  runner contract, and Codex seats' `rig: command not found` are fixed or
  changed. The 0.7.8 limits below that 0.7.9
  didn't fix or change, and the
  [0.7.7](https://github.com/mvschwarz/openrig/releases/tag/v0.7.7) and
  [0.7.6](https://github.com/mvschwarz/openrig/releases/tag/v0.7.6) limits, still
  apply.

---

## What changed in OpenRig 0.7.9

The changes from 0.7.8 to 0.7.9, published on 2026-11-06, for an install
upgrading from 0.7.8 or earlier.

### After the upgrade

- **Restart the daemon** to load the new code: `rig daemon stop`, then
  `rig daemon start`.
  - **Migrations 146 to 149** record a Pi seat's guidance file, what OpenRig last
    wrote in each managed guidance block, an index for reading a rig's outbox,
    and the stream intake position.
- **Tell the person that stream intake is on.** Each `rig stream emit` now opens
  an intake row for the kernel queue worker (`queue.worker`), or adds a note to
  the one still unclaimed, and the row wakes the queue worker like any queue row.
  Earlier stream history isn't replayed. If they want 0.7.8's behaviour, with no
  intake rows, run `rig config set stream.intake off`.
- **The bundled openrig-core plugin goes from 0.1.24 to 0.1.25.** Its
  seat-continuity-and-handover skill changed. Managed refresh preserves replaced
  files under `$OPENRIG_HOME/backups/managed-refresh/<id>/`; reapply local edits
  you still need from the preserved copy.
- **Where seat guidance goes now:**
  - a fresh Pi seat gets OpenRig's guidance in its own agent folder's
    `AGENTS.md`, unless that file or folder is a link;
  - a fresh Codex seat on Codex 0.164.0 or later gets it as launch developer
    instructions, not in the repository `AGENTS.md`, when no config layer
    OpenRig reads sets `developer_instructions`;
  - a Codex resume, fork, restore or handover successor, an older or unknown
    Codex, and a config layer that sets `developer_instructions` or can't be read
    still use the repository `AGENTS.md`;
  - if only the person's shell startup sets `CODEX_HOME`, OpenRig reads
    `~/.codex`, so a `developer_instructions` set in their home is replaced for
    that session. Declare the same absolute path as `CODEX_HOME` in the member's
    or rig's `env:` to have it checked. `docs/reference/agent-startup-guide.md`
    ("Codex guidance at launch") is the rule;
  - a managed block a person edited by hand is kept and named
    (`guidance_block_edited`), not replaced. Read the warning before you change
    the block.
- **Slack:** on the first start after upgrading, the connector edits the asks
  that ended earlier to show they were handled, at Slack's edit rate: about an
  hour for 450 asks. `rig slack status` shows pending edits.
- **OpenShell:** rebuild a guest image built for 0.7.8 with this release's
  helper; an older helper rejects the new startup step, and the error names the
  rebuild.

### Runner seats

Section 7 of `docs/reference/harness-runner-contract.md` is the rule for
permissions, and section 4 for activity. Read them before writing or changing a
runner.
- **Typed words:** a reply of just yes or no counts as the agent's allow or
  reject. Any other words choose nothing: OpenRig's default permits the request
  when the agent offered an allow option, and the read result carries the words
  whole as `said`. A runner may queue them for the agent as an ordinary prompt
  after the current turn, never as the answer; one that drops them still keeps
  the contract. The ask now tells the person this.
- **Permit records:** each permit OpenRig decides by default (no one to ask, or
  an ask closed without a choice, including a row passed to an agent seat) is
  recorded once, as a stream item from the seat, naming the tool call, why no
  person answered and the option given. Read them with
  `rig stream list --tag runner-permission-permit` or `--source <seat>`. A record
  has no destination and never changes the permit. Stream intake reads past it, so
  it opens no intake row and wakes no one.
- **The working beat:** while a prompt is outstanding and the agent is alive, a
  runner may post `active` / `liveness` so a long call keeps reading working.
  After delivering an answer or permit, it posts `active` /
  `permission_resolved`. A runner that sends no beats behaves as before. The Pi
  runner and the dsh example post it.
- **Check a runner** with
  `node daemon/docs/reference/runner-conformance/check-runner.mjs --runner '<command with {agent}>' --name <harness>`.
  It now covers the beat, and no longer falsely fails a correct runner on a busy
  machine.
- **The dsh example** reads `DSH_SEAT_BIN` and `DSH_SEAT_HOME` from the member's
  `env:`, and section 8 names ACP's `session/resume`.

### OpenShell workers

0.7.9 includes a repair for the OpenShell worker that wasn't usable in 0.7.8,
but the worker still doesn't work in 0.7.9. Don't rely on this path in 0.7.9.
Startup reaches the guest through a hash-checked first-input file, and nothing
is typed through the host viewer. Readiness checks the guest's own execution,
and a failed owned delete reports the stage that failed. Release testing on
0.7.9 then found two more problems: the guest's Claude couldn't reach its model
(`SELF_SIGNED_CERT_IN_CHAIN`), because the guest launcher left out the CA
settings the OpenShell exec supplies, and deleting an owned environment never
sent the delete, because its inventory step misread a "Not Found" reply. 0.7.10's
fixes for both are described above. "Never grant the guest access to the
daemon's main API port (normally 7433)."

### Assistants connected through a grant service (experimental)

Experimental, unsupported, off by default, and at the person's own risk. With
`rig mcp serve --http --grant-service <url>` and a grant service the person
supplies and runs, a connected assistant can claim, update and park the rows
addressed to its own seat, and see its team with `rig_team`, within the scope its
existing tools have. Nothing wakes it: an item stays queued until its receiver
claims it. Name the outside service, and the exposure of serving MCP over HTTP,
to the person before you set this up. `docs/reference/hosted-members.md` is the
rule.

### Other changes to act on

- **Held messages:** a seat that starts, or takes over a seat, with held
  messages is told how many there are. Read them with
  `rig seat held-messages <seat>`.
- **Unconfirmed sends:** `rig send --verify` now reports unconfirmed and exits 1
  when it can't see what its Enter did, and `rig walk` reports unconfirmed
  instead of lost. Inspect the recipient before any resend.
- **Deadlines:** to accept a re-estimate without unclaiming the work, run
  `rig queue update <id> --closure-required-at <ISO>`.
- **Shared workspaces:** any registered person can settle another's ask as
  themselves, and the first committed answer wins; a later answer gets 409
  `qitem_already_terminal` and records nothing. A person registered with no
  connector binding is asked on Steering and in the Feed only.
- **Handover:** a fresh or rebuild successor's first turn lists its startup
  files, role first. A successor that started without a required startup file is
  marked in the seat list.
- **Ambiguous rig names:** when an active rig name matches more than one rig,
  `rig env down`, `status` and `logs` list the matching rig IDs and stop, and
  `rig doctor --spec` reports conformance as unknown. Use the rig ID.
- **Seat activity:** window samples older than their bound no longer decide a
  seat's activity, so a seat whose pane can't be read reads unknown rather than
  its last verdict. Treat unknown as unknown, not idle.
- **Launch options:** `specs.builtins_visible: false` hides built-in specs
  (`rig specs ls --include-builtins` still lists them); `plugin_channels` gives
  one Claude member its own `--channels`, untested with a real channel plugin.
- **Files:** `rig down` removes OpenRig's own additions from a working folder
  once no live seat uses them. `rig export` with no `-o` writes
  `rig-export.yaml` beside an existing `rig.yaml`. `rig workspace validate` exits
  1 for malformed optional frontmatter.
- **Kernels:** a new default kernel starts in `<workspace.root>/kernel`.
  Existing kernels stay where they are. `docs/reference/agent-startup-guide.md`
  explains the optional move; a fresh launch there starts a new native
  conversation, so ask the person before moving.
- **PATH:** if preflight warns that a Codex seat's login shell can't find `rig`,
  follow its fix. `getting-started.md` explains the `~/.profile` line and how to
  check it with `bash -lc 'command -v node rig'`.

### Limits to keep in view

- **OpenShell:** the worker doesn't work in 0.7.9 (above). A same-generation
  reconciled launch opens no viewer, so run `rig environment connect` yourself;
  non-text startup actions aren't supported on environment seats.
- **Open updates for a person** read a 1,001-row window, so a page can come back
  short, marked `truncated`.
- **Slack:** a private channel needs the documented route, which isn't tested,
  and direct messages aren't supported. The channel and people reads haven't
  been run against a live Slack workspace. Redaction of the bot token from a
  transport error can still leave a malformed token fragment shorter than six
  characters, so review an error before sharing it.
- **SSH host status** reads `unknown` behind a ProxyJump or ProxyCommand; that
  isn't proof the connection is broken. `rig host ls` reads the ssh config with
  `ssh -G`, which runs any `Match exec` command in it.
- **Shared asks:** a click's option written before its answer row can stand
  beside or inside the closer's answer without the first clicker's authorship.
- **Permit records** last as long as stream retention keeps them. A permit a
  runner makes on its own, when it can't reach OpenRig, is in its pane only. For
  an ask opened before 0.7.9, a record may omit the option's kind.
- **Existing seats** pick up Codex launch instructions and the single
  openrig-core skill load at their next fresh launch. A `CLAUDE.md` or
  `AGENTS.md` that already grew a line per launch isn't trimmed.
- **Codex hooks after an upgrade:** Codex sessions kept running across the
  upgrade show "Hook failed — plugin contents changed; hook approval required"
  until relaunched.
- **0.7.8's limits** on the dsh `env:` names, conformance false failures, typed
  words, the README's operator address, a symlinked rebuild, the rebuild receipt,
  a re-parked click and unrecorded default permits are fixed or changed. The
  other 0.7.8 limits below, and the
  [0.7.7](https://github.com/mvschwarz/openrig/releases/tag/v0.7.7) and
  [0.7.6](https://github.com/mvschwarz/openrig/releases/tag/v0.7.6) limits, still
  apply.

---
