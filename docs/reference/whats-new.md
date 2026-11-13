# What changed in OpenRig 0.7.14

This note is for an agent on an install that was just upgraded to 0.7.14.
OpenRig 0.7.14 makes concurrent node reads take turns, so other reads and sends
aren't held behind a whole burst, and indexes bounded queue listings over
retained history. A connected assistant reaches a seat by its plain name and
hears three new errors when it can't. Connected assistants show in `rig ps`,
`rig_team` and the TUI. It adds three database migrations. If you upgraded from
0.7.12 or earlier, also read "What changed in OpenRig 0.7.13" below, and so on
back. For the full capability map, read
`rig context get onboarding-width/public-what-you-can-do.md`. After the upgraded
daemon starts, `rig context get reference/whats-new.md` describes this version.
Without a running daemon, read the packaged `daemon/docs/reference/whats-new.md`.

## After the upgrade

- **Stop, back up, install, then start.** `rig daemon stop` (seats keep running,
  so don't use `rig down`), copy the database file (`rig config get db.path`
  shows it), install 0.7.14 with the existing installation method, then
  `rig daemon start`.
- **Three migrations run before the daemon listens.** Migration 163 adds the
  `network_installations` table and four columns to `network_bindings`.
  Migrations 164 and 166 build indexes. The author's measurement of 166 took
  3.47 s on 28,976 rows, not a real installation's size, so a large database can
  take longer. The write overhead, and going back to 0.7.13 after these three
  migrations, aren't established; keep the backup.
- **If the start is reported pending:** the CLI waits 20 s, then may print
  "Daemon startup is pending after the readiness deadline". Readiness remains
  unconfirmed. It leaves the child running and the startup reservation
  retained, without recording the daemon. Inspect the address and log it
  prints. The child may later answer, and status can then report it running,
  but that does not finish this start's recording or release its reservation.
  Don't start it again. To return to a normal start, follow the restart steps
  in the message: stop the named child PID and wait for exit, inspect
  `daemon-start.lock`, and only when both recorded launcher and child PIDs are
  absent, archive the lock and run `rig daemon start`. `rig daemon stop` cannot
  stop that unpublished child.
- **The plugins:** openrig-core stays 0.1.29. The `openrig` plugin's manifests
  carry the CLI's version, 0.7.14.

## Reads, seats and people

- **Node reads take turns** through their three synchronous steps (inventory;
  activity; terminal and work). A nodes response is no longer one snapshot
  across those steps, and in a burst each response comes later: about 43 ms
  against 21 ms median in a 24-request burst. One very large rig is still one
  step. ([#3101](https://github.com/mvschwarz/openrig/pull/3101))
- **A plain seat name over MCP** resolves to the seat's actual session: its own
  name, then its pod-member form, then that name's slug, among seats the grant
  can address. Three errors are new: `destination_ambiguous` (pass one of the
  listed candidates), `destination_not_found` (no reachable seat has that name;
  `rig_team` lists the names) and `destination_unchecked` (the team couldn't be
  read; try again). ([#3088](https://github.com/mvschwarz/openrig/pull/3088))
- **Connected assistants** are listed with their check-in line in `rig ps`,
  `rig_team` and the TUI's tables. The check-in is a status, never a gate on
  delivery. ([#3057](https://github.com/mvschwarz/openrig/pull/3057), [#3058](https://github.com/mvschwarz/openrig/pull/3058))
- **Before a first team launches, check the logins it needs.** `rig doctor` and
  setup now explain that a missing login matters when a seat you would start
  runs on that harness. The operator is taught to check before launch;
  `rig specs preview <team> --kind rig --json` shows each seat's runtime.
  ([#3077](https://github.com/mvschwarz/openrig/pull/3077))
- **Registration guidance:** when the readable person registry holds nobody,
  `rig daemon start` and `rig gateway participants` tell the setup agent to
  offer registration. The kernel operator is taught to offer it in its greeting
  and register only on a yes. ([#3041](https://github.com/mvschwarz/openrig/pull/3041), [#3071](https://github.com/mvschwarz/openrig/pull/3071))

## Other changes to act on

- An ordinary send is refused as needing input while an open Claude Code or
  Codex `/model` picker is positively identified; nothing is typed. Close the
  picker before trying to deliver the message. ([#3083](https://github.com/mvschwarz/openrig/pull/3083))
- On a resume of a Codex seat's own conversation in a rig with pods, including
  `rig up --existing`, OpenRig avoids adding missing guidance blocks to the
  repository's tracked `AGENTS.md` when Codex is 0.164.0 or later, no guidance
  file or developer instructions are configured, and the configuration and
  block sources can be read. ([#3039](https://github.com/mvschwarz/openrig/pull/3039))
- `rig queue list --tag <t>` (repeatable, all must match), `--mission` and
  `--slice` filter exactly. ([#3066](https://github.com/mvschwarz/openrig/pull/3066))
- `rig broadcast` prints a held recipient as retained; nothing was typed there.
  ([#3054](https://github.com/mvschwarz/openrig/pull/3054))
- `rig compact --state` names the input check that stopped a managed
  compaction (`inputReadFailure`). ([#3053](https://github.com/mvschwarz/openrig/pull/3053))
- `rig workflow validate` adds a `harness_pin_unchecked` warning for each
  pinned step. ([#3102](https://github.com/mvschwarz/openrig/pull/3102))
- Account erasure also removes OpenRig's own wakes and notices for the
  account's seats. ([#3089](https://github.com/mvschwarz/openrig/pull/3089))
- With `recovery.auto_drive_provider_prompts` on, Claude Code's gated-grants
  trust check is never answered for you. ([#3073](https://github.com/mvschwarz/openrig/pull/3073))

## Limits to keep in view

- **Queue listings:** the new indexes aren't a cure for every stall. Listings of
  active work showed no gain, one case was slower, and writes weren't measured.
  ([#3090](https://github.com/mvschwarz/openrig/pull/3090))
- **Draft-aware delivery ([#3076](https://github.com/mvschwarz/openrig/issues/3076)):** an automatic notice can still be left beside a
  draft started during delivery.
- **The TUI's tables** can drop a connected assistant's check-in line when its
  rig's seat inventory can't be read; `rig roster` still prints it.
- **Repository guidance on restore:** rigs without pods, old or unknown Codex
  versions, configured guidance and unreadable configuration keep the existing
  file path. Fresh, fork and handover launches are outside this resume fix.
  Existing managed blocks may still refresh, and the seat-skills line still
  belongs to the file writer; check `git status`. A block whose source can't be
  read is reported missing.
- **From 0.7.13:** its limits below still apply, except where this release
  fixes them. The runtime fixes cover adding missing guidance on the eligible
  Codex resumes described above, recognized model pickers and the unquoted
  pairing description. This release also changes the operator-first
  registration and pre-launch login guidance; their observed outcomes aren't
  established yet.

## What changed in OpenRig 0.7.13

This note is for an agent on an install that was just upgraded to 0.7.13.
OpenRig 0.7.13 writes a person a note after they answer a runner's permission
request and wakes the waiting runner on the decision. It tells a receiving agent
what an answer typed at the machine means and how to ask the person back.
`rig daemon start` tells the setup agent to offer to register the person when nobody is registered,
and a usage-limited Claude seat waits for the reset its message states. It adds
three database migrations. If you upgraded from 0.7.11 or earlier, also read
"What changed in OpenRig 0.7.12" below, and so on back. For the full capability
map, read `rig context get onboarding-width/public-what-you-can-do.md`. After the
upgraded daemon starts, `rig context get reference/whats-new.md` describes this
version. Without a running daemon, read the packaged
`daemon/docs/reference/whats-new.md`.

### After the upgrade

- **Back up the database, then restart the daemon.** Three migrations run on the
  daemon's first start: 160 and 161 (network bindings and receipts, for the
  experimental hub connector) and 162 (indexes for current-session reads). If
  `$OPENRIG_DB` isn't backed up yet: `rig daemon stop` (seats keep running, so
  don't use `rig down`), copy that file (`rig config get db.path` shows it),
  then `rig daemon start`. Going back to 0.7.12 after these migrations isn't
  established.
- **The plugins:** openrig-core moves from 0.1.28 to 0.1.29 (its activity relay
  and refocus hooks changed). The `openrig` plugin's manifests now carry the
  CLI's version, 0.7.13. A Codex session kept running across the upgrade can ask
  for hook approval until it's relaunched.

### Answers, setup and seats

- **A runner's permission answer gets a note back to the person:** who decides
  it and in what state, or that it's kept and the tool hasn't run. A runner
  already waiting sees the decision at once. If a person asks what happened to
  an answer, read that note before asking them to answer again. If it says the
  answer couldn't be passed on, follow its retry instruction or use the
  `rig seat decide-permission` command it names.
  ([#3001](https://github.com/mvschwarz/openrig/pull/3001))
- **If you receive a person's answer**, the text you read now says what an answer
  typed at this machine's terminal or TUI means (recorded as `human@host`): act
  on a clear one with the request's own decision command, and don't ask them to
  confirm. When it's unclear, ask them back with a new ask to them
  (`rig queue create --destination <person> …`), never to `human@host`. When the
  default receiving agent asks back, the question reaches the person's Feed and
  their reply decides. Closing a runner's request without deciding permits nothing.
  ([#3030](https://github.com/mvschwarz/openrig/pull/3030))
- **Setup:** when the person registry can be read and holds nobody,
  `rig daemon start` ends by telling the setup agent to offer to register the
  person, with the command to run only on their yes; pass it on. Asking to be
  reachable registers the person as the default directly. In fresh-install
  tests the setup agent passed the offer on in 5 of 6 installs, and a no
  registered nothing. `rig up`, `rig start` and `rig context` start the daemon
  without printing it. A person who talks to the
  kernel operator first isn't offered registration in this release: offer
  `rig gateway human add` yourself. ([#3028](https://github.com/mvschwarz/openrig/pull/3028))
- **A first team's permissions:** in the change's own tests, before launch, the
  kernel operator names the commands the team will ask for, reuses a choice the
  person made, or makes one project-scoped offer, applied on their yes. Don't
  tell the person it means fewer asks: that hasn't been shown. Chained commands
  and OpenRig's own lifecycle commands still ask on Claude seats. ([#3029](https://github.com/mvschwarz/openrig/pull/3029))
- **A usage-limited Claude seat** whose limit message states a reset time parks
  its pending work until then. Don't release it on a timer.
  ([#2917](https://github.com/mvschwarz/openrig/pull/2917))

### Other changes to act on

- **Handover:** a handover whose successor launched but isn't ready says it may
  be running. Look at the pane (`rig capture '<seat>'`) before another handover
  or a fresh launch, either of which ends it. A handover also cleans up the
  retiring occupant's own claims and jobs. ([#3003](https://github.com/mvschwarz/openrig/pull/3003), [#3024](https://github.com/mvschwarz/openrig/pull/3024))
- **Adopted sessions:** release one with `rig unclaim <session>`, then end its
  process and its tmux session. Closing its viewing window only detaches it. A
  fresh launch after that ended the server's last session reopens the server.
  ([#2996](https://github.com/mvschwarz/openrig/pull/2996), [#3006](https://github.com/mvschwarz/openrig/pull/3006), [#3009](https://github.com/mvschwarz/openrig/pull/3009))
- **Connected assistants** show a check-in status against the cadence their
  roster entry states (`check_in_minutes` or `check_in_on_request: true`), as a
  Check-in line in `rig roster show` and `find`. It's a status, not a delivery
  gate, and a cadence is the person's statement, not proof the assistant ran.
  ([#3023](https://github.com/mvschwarz/openrig/pull/3023))
- **Passive SSH host status reads `unknown`** now that routine listings don't
  probe SSH hosts. Use `rig host doctor` to check one. ([#2979](https://github.com/mvschwarz/openrig/pull/2979))
- **Guidance files:** cleanup removes redundant recognized copies of a managed
  block and keeps distinct edited copies. A saved write record lets OpenRig keep
  a person's edits; on a fresh start, a differing block with no write record is
  refreshed and named, while an exact resume or restore keeps it. A recognized
  block whose marker pair is incomplete is named
  (`guidance_block_markers_damaged`) and left as it is; repair the marker by
  hand. If both marker words were changed, it can read as no block. ([#3020](https://github.com/mvschwarz/openrig/pull/3020))
- **Delivery reads truer:** Claude's auto-update failure footers (one clipped form
  too) no longer hold a send, an unrecognised wake result reads unknown, and an
  ordinary one-time park wake is kept and retried while its park is
  current and the failed attempt typed nothing (an unknown effect needs checking;
  repeating waits and usage-limit expiry keep their own lifecycle). ([#2948](https://github.com/mvschwarz/openrig/pull/2948), [#3016](https://github.com/mvschwarz/openrig/pull/3016), [#3011](https://github.com/mvschwarz/openrig/pull/3011), [#3038](https://github.com/mvschwarz/openrig/pull/3038))
- **The TUI:** for a quiet seat the daemon explicitly reads as unknown, the
  list, explorer and agent-detail status rows show unknown. Screen motion still
  shows active, a daemon that serves no activity keeps the screen fallback, and
  the topology graph is unchanged. Feed times use `ui.timezone`. ([#3012](https://github.com/mvschwarz/openrig/pull/3012), [#3022](https://github.com/mvschwarz/openrig/pull/3022))
- **Experimental, at the person's own risk:** `rig network` connects one local
  seat to a hub they already have. The connector uses the MCP SDK, which the
  installed package already included in 0.7.12. The daemon starts it even with
  no binding.
  ([#2993](https://github.com/mvschwarz/openrig/pull/2993))

### Limits to keep in view

- **Not in this release:** a Codex snapshot restore or `rig up --existing` can
  write OpenRig's managed guidance into a tracked `AGENTS.md`, leaving the
  worktree modified; check `git status` after either operation.
- **Not in this release:** the kernel operator's own registration offer, as above
  ([#3041](https://github.com/mvschwarz/openrig/pull/3041)). While nobody is registered, `rig daemon start` repeats its offer
  even after a no; nothing is registered without a yes.
- **Speed and memory:** On one performance host, whole `rig queue create`
  invocations had a median about 10.4% slower than 0.7.12 (about +29 ms). Send
  latency stayed within the comparison's unchanged range. The cause remains
  unidentified. The standard idle-memory comparison was inconclusive. A post-hoc
  analysis of the same six runs found 7.9–8.6 MiB (4.2–5.3%) higher daemon RSS
  across three matched idle windows, using the median of three arm medians per
  version. The cause and steady-state behavior remain unestablished.
- **Draft-aware delivery ([#3076](https://github.com/mvschwarz/openrig/issues/3076)):** an automatic OpenRig notice can be left beside a
  draft started during delivery. This also concerns notices admitted by
  openrig-urgent and urgent-only modes. In the reproduced 0.7.12 Claude Code and
  Codex cases, the person's draft remained intact and no Enter was sent, but
  OpenRig's text stayed in the input. The guard and paste path are unchanged in
  this cut; a native 0.7.13 reproduction has not run.
- **Native model pickers:** with a /model picker open, an ordinary send can act
  on the picker instead of delivering the message. In 0.7.12 tests it confirmed
  Claude Code's already-selected default and advanced Codex's model selection;
  neither message reached the model. Close or deliberately resolve the picker
  before ordinary delivery. The native 0.7.13 case has not run.
- **Codex hook review after an upgrade:** in one test whose Codex home already
  held earlier hook approvals, `rig up --existing` stopped for hook review in
  each Codex pane; approving the hooks resumed all three conversations. A
  separate test of the same upgrade on a fresh Codex home, on another host,
  restored without review. The cause of the difference is not established.
- **A first team with Codex installed but signed out:** a Claude person's starter
  team includes a Codex reviewer that waits for a Codex sign-in, and the person
  isn't told beforehand. If Codex is installed, have them sign in first.
- **The hub connector isn't inert:** it starts, sweeps leftover credential
  folders and schedules local rounds even with no binding; only the hub pass is
  absent. Don't describe it as off. ([#2993](https://github.com/mvschwarz/openrig/pull/2993))
- **The recorder:** a queued begin record can be lost before the durable append,
  and a stalled worker has no acknowledgement timeout. ([#3019](https://github.com/mvschwarz/openrig/pull/3019))
- **Proof reads** are much more responsive, but still pause briefly, and a whole
  read takes slightly longer. It isn't a hard latency bound or an atomic snapshot. ([#2970](https://github.com/mvschwarz/openrig/pull/2970))
- **Usage-limit parking** was tested with `claude -p`'s message; if an
  interactive seat's report lacks it, the seat is retried as before. ([#2917](https://github.com/mvschwarz/openrig/pull/2917))
- **Handover:** a context delivery failure, and a Codex launch failure after an
  undismissed update prompt, can still say "retry" while a successor runs.
  ([#3003](https://github.com/mvschwarz/openrig/pull/3003))
- **Answers:** an ask-back can stop at Claude Code's own permission prompt,
  which the person doesn't see. A receiving agent the person chose can still
  decline to act on a clear answer. A pairing requester's description is quoted
  for the receiving agent but not yet in the request's summary or notices.
  ([#3030](https://github.com/mvschwarz/openrig/pull/3030))
- **0.7.12's limits below** still apply, except that [#2970](https://github.com/mvschwarz/openrig/pull/2970) and [#2948](https://github.com/mvschwarz/openrig/pull/2948)
  are now in this release, runner answers are confirmed and reach a waiting
  runner at once ([#3001](https://github.com/mvschwarz/openrig/pull/3001)), and `rig seat stop` no longer suggests `rig down`
  for an adopted session ([#3006](https://github.com/mvschwarz/openrig/pull/3006)). 0.7.12's not-run list was for that release.

## What changed in OpenRig 0.7.12

This note is for an agent on an install that was just upgraded to 0.7.12.
OpenRig 0.7.12 routes a person's typed, clicked or qualified answers with the
question to the configured receiving agent or the kernel operator to decide.
Answers wait when no receiver is available. Setup's guidance asks the agent to
offer to register the person, which it didn't reliably do in testing. `rig down` stops
only terminals it can show belong to the seat. It adds five database
migrations. If you upgraded from 0.7.10 or earlier, also read "What changed in
OpenRig 0.7.11" below, and so on back. For the full capability map, read
`rig context get onboarding-width/public-what-you-can-do.md`. After the upgraded
daemon starts, `rig context get reference/whats-new.md` describes this version.
Without a running daemon, read the packaged `daemon/docs/reference/whats-new.md`.

### After the upgrade

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
  For a terminal OpenRig didn't create, or a mismarked or replaced one, it exits
  2 and names the terminal and how to stop it. A seat joined with `rig attach` as
  an external CLI is listed as not stopped, which alone doesn't make it exit 2.
  Tell the person, and stop those by hand if they're theirs to stop.
  ([#2962](https://github.com/mvschwarz/openrig/pull/2962))

### Answers from a person reach an agent

- Answers nothing else reads, such as a host pairing request or a mode's
  scheduled end, use the configured receiving agent or the kernel operator.
  Answers wait when no receiver is available, and nothing decides them
  meanwhile; a direct decision uses the request's own command (`rig host approve`
  or `rig host deny`, `rig seat decide-permission`). An ordinary close isn't
  permission, and kept words aren't a default permit. ([#2923](https://github.com/mvschwarz/openrig/pull/2923))
- Pairing answers go to the receiving agent, and a person can decide directly in
  the TUI's pairing settings. ([#2931](https://github.com/mvschwarz/openrig/pull/2931), [#2935](https://github.com/mvschwarz/openrig/pull/2935))
- A runner's permission answer goes to the receiving agent, which decides while
  the runner waits, so a qualified answer ("only if it's the test file") is
  read before anything acts. The answer is kept and an explicit decision works,
  but the runner's confirmation updates to the person aren't written in this
  release: no Feed confirmation, receiver-state notice or immediate wake. The
  decision reaches the runner at its next read (up to about 21 seconds in
  testing). Decide one directly with `rig seat decide-permission`. ([#2934](https://github.com/mvschwarz/openrig/pull/2934))
- **What to do:** design for an agent to read the person's answer with its
  question and decide. If no receiver is available, say the answer is waiting;
  don't describe it as read or decided. Pairing settings in the TUI also offer
  the direct decision described above.
- **A chosen receiver** (`agents.operator_session`) in an explicit or auto
  permission mode gets no OpenRig allowance for `rig host approve` or `deny`, so
  Claude's review can refuse them; a kernel receiver in auto mode is included.
  The default kernel with the default policy passed at its tested scope.
- **A receiver that was stopped and then started** may not act on an answer
  that waited for it. When it needed to ask back in testing, the question
  appeared in its own conversation, not in the Feed or Steering.

### Other changes to act on

- **Setup's guidance** asks the agent to offer to register the person; in
  testing it didn't reliably make the offer (0 of 5 runs). Registering works
  when the person asks for it (`rig gateway human add`): nothing is registered
  without their yes, an existing default is kept, and no person is chosen
  automatically. A team started from the person's own assistant fits their
  logins, with a review before commit. ([#2924](https://github.com/mvschwarz/openrig/pull/2924), [#2905](https://github.com/mvschwarz/openrig/pull/2905))
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

### Limits to keep in view

- **Not in this release:** daemon pauses of up to about a second while reading
  proof on large mission trees ([#2970](https://github.com/mvschwarz/openrig/pull/2970)), and a delivery stall to a Claude seat
  showing Claude's auto-update failure footer ([#2948](https://github.com/mvschwarz/openrig/pull/2948)). Don't tell a person
  either is fixed.
- **`rig down`** keeps no stored host or boot identity, doesn't guard against
  another program running as the person, and a daemon restart between losing the
  tmux server and the stop wasn't exercised. ([#2962](https://github.com/mvschwarz/openrig/pull/2962))
- **Codex working counter:** a capture that doesn't name its pane keeps the old
  comparison, and a restart that keeps the pane and its process id isn't seen.
  ([#2980](https://github.com/mvschwarz/openrig/pull/2980))
- **Custom blocker IDs** explain the wait but give no event wake; the timer
  remains. ([#2983](https://github.com/mvschwarz/openrig/pull/2983))
- **Runner permission answers** were run end to end with a real receiving agent
  and the example runner, whose requesting agent was a stand-in; a model-driven
  runner waiting on a person's answer hasn't been run. ([#2934](https://github.com/mvschwarz/openrig/pull/2934))
- **An already-running tmux server** keeps its old environment, daemon
  credentials included, until it restarts. ([#2850](https://github.com/mvschwarz/openrig/pull/2850))
- **Delivery:** events are best effort, so a missing event isn't proof nothing
  was sent. A footer row OpenRig doesn't recognize can still hold a delivery ([#2925](https://github.com/mvschwarz/openrig/issues/2925)),
  and a held message's full envelope can stay held; clearing a draft doesn't
  deliver it ([#2515](https://github.com/mvschwarz/openrig/pull/2515)). With unreadable input, `--dangerously-interact` pastes
  with a warning and doesn't press Enter ([#2800](https://github.com/mvschwarz/openrig/pull/2800)).
- **Not run for this release** (not run, not passed): the two-seat Codex journey
  with `AGENTS.md` restore; Codex account-home, upgrade and continuity checks;
  the OpenShell worker's second report; Pi model switches on real providers; ACP
  in a desktop app; Slack directory paging; some Slack setup cases; native
  checks of [#2786](https://github.com/mvschwarz/openrig/pull/2786), [#2799](https://github.com/mvschwarz/openrig/pull/2799), [#2807](https://github.com/mvschwarz/openrig/pull/2807) and [#2813](https://github.com/mvschwarz/openrig/pull/2813) ([#2947](https://github.com/mvschwarz/openrig/pull/2947) partly); a button-and-words
  answer, a non-pairing ask with an explicit owner, Steering's Approve page, and
  the answer and setup checks on a default model; `--wait-for-kernel` ([#2888](https://github.com/mvschwarz/openrig/pull/2888)),
  [#2800](https://github.com/mvschwarz/openrig/pull/2800)'s installed effect, and [#2720](https://github.com/mvschwarz/openrig/issues/2720) beyond one platform. Don't tell a person
  these work.
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
