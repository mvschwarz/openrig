# What changed in OpenRig 0.6.12

This note is for an agent on an install that was just upgraded to 0.6.12. It lists only what behaves differently from
0.6.11 and what to do about it. For everything OpenRig can do, read the capability map:
`rig context get onboarding-width/public-what-you-can-do.md`. Each release replaces this file, so
`rig context get reference/whats-new.md` describes the installed version once the upgraded daemon is running. Without
a running daemon, read `$OPENRIG_HOME/reference/whats-new.md`. The daemon refreshes that copy when it starts, so right
after an upgrade it can still hold the previous version's note.

## After the upgrade

- **Restart the daemon** (`rig daemon stop`, then `rig daemon start`). Twelve migrations run on the first start,
  whatever you use: `100`, `104`, `105`, `107` to `115`. They add columns and tables for the typing guard's modes, a
  seat's saved effort, Claude's cost estimate, Pi usage, mode and posture categories, workflow scope, seat environment
  values, the Codex `--no-daemon` record and `sessions.agent_app`; build two indexes for recent queue activity (about
  10 to 12 MB on a long-running install); and rebuild the Slack thread map. There are no migrations `102` or `106`.
- **Claude seats now run the openrig-core plugin's hooks.** The bundled plugin goes from 0.1.9 to 0.1.13. A Claude
  seat whose plugins include `openrig-core` (every shipped agent spec selects it) starts with `CLAUDE_CODE_PLUGIN_DIRS`
  pointing at OpenRig's copy, so the activity relay, the compaction save and restore hooks and refocus actually run. It
  needs Claude Code 2.1.280 or later, which nothing checks. A running seat picks it up at its next launch, restore or
  handover. The refocus hook may take up to 60 seconds, so a hung refocus can hold a prompt that long.
- **Six new settings, all off except one:** `output.whoami_peers` (8, used only while `output.compact` is on),
  `bundle.services_enabled`, `provider.subscription_moves`, `usage.pi_cost_facts`, `usage.pi_openrouter_charge` and
  `transport.verify_input_box`. See "Off by default" below.

## Output that changed shape

- **Exit codes:** eleven client-fixable `rig queue update` refusals now answer HTTP 400 and exit 1 instead of 500 and
  exit 2 (`blocker_not_found`, `blocker_not_live` and `blocker_malformed` still exit 2). `rig ask` exits 1 for an
  unknown or ambiguous rig. `rig compact` exits 1 (was 2) for `pane_unknown_protected`, and its route answers 409 (was
  502). Over the shared transport, a write that throws without a code makes `rig send` exit 1 with HTTP 409 instead of 2
  with 500, and a guarded send whose text was written returns `sent: true` with `inputPhase: "written"`.
- **`rig compact` and `rig compact --state` add a `compact` result:** `submitted_unconfirmed` (shown as "submitted,
  unconfirmed"), `uncertain` or `not_sent`. "Submitted" means `/compact` and Enter reached the seat, not that compaction
  ran.
- **`rig capture --lines N --json`** adds `activity: "unknown"` and `activityNote` when lines were cut.
- **`rig start --last --json`** carries `keptDown` (always) and `warnings` (`seat_status_unreadable`).
- **`rig queue show <id> --full`** on a closed row adds `closingTransition`; plain `rig queue show` on such a row reads
  `readView.complete: false` and lists it in `omittedFields`. `rig queue show` returns `resolution` when a close stored
  one.
- **After `rig down`,** `rig ps`, the TUI and the rig summary read the rig `stopped`, not recoverable, and
  `hasLiveAgents` can read `false`.
- **`rig seat status`** reads `Typing guard: on (hold)` for hold, and its JSON's `desired` and `effective` mean hold only;
  `desiredMode` and `effectiveMode` give the mode.
- **`rig usage top`** measures tokens and rates within one conversation and one window, so figures can drop and more
  seats read `insufficient_samples`.
- **The execution view** binds a row to a mission by its exact `mission:` tag first; `q1_lanes[].waiting` and
  `folded.merge_report` are new.
- **Smaller:** `rig create --json` carries `detail` on failure; `rig status --json` is new; `rig mcp serve` lists 23 tools
  (five queue tools added); a JSON body of `null` gets 400 `invalid_json`; `GET /api/events` takes `?replay=`; a Slack
  seat post's sender line ends `on <host id>`; `rig ps --nodes` `resumeCommand` can carry `--no-daemon`.

## Seats and restore

- **`rig start --last` leaves down a rig stopped on purpose** (`rig down` or `rig seat stop`) and prints how to bring it
  back: `rig start --rigs <rig>`, or `rig up '<name>' --existing`.
- **An ordinary terminal seat relaunches fresh on restore** and re-runs its startup actions; don't answer `--fresh` for
  it. A missing required startup file for such a seat blocks the whole restore before anything launches.
- **Restore stops a seat whose current runtime differs from its snapshot's,** before launching it; `--fresh` doesn't
  bypass it. Restore from a snapshot taken with the seat's current runtime.
- **A slow Claude restore ends `attention_required`, not failed:** "Claude resume did not finish within Ns; Claude may
  still be starting, so the launch was kept". Look at the pane, and once Claude is up run `rig seat clear-attention`.
  Each such seat can add up to about the readiness timeout, one after another, so `rig up` can pass its 120-second
  wait while the daemon keeps working: check `rig ps` before running it again.
- **"Returned to a shell" now means the process tree shows an idle shell.** "The pane shows a shell that is not a proven
  idle shell; a launch script may still be starting …" means the seat may still be coming up. A Pi or OMP seat at a
  bare shell reads `attention_required`.
- **A Codex fork whose new conversation ID arrives late** stops at `attention_required` with its startup context kept;
  let it finish starting, then run `rig seat continue <seat>`. A handover to a Codex fork can complete with `Fork id:
  PENDING`.
- **A seat whose startup failed for a recoverable reason** becomes ready after a successful send or capture.
- **`rig launch` takes a rig's name as well as its ID;** a name two active rigs share stops with `rig_ambiguous`.
- **`rig add`, single-seat `rig launch` and `rig launch --seats` wait up to 120 seconds.** A timeout still isn't a
  rollback.
- **A runtime `--version` check gives up after 30 seconds.** `rig bootstrap` blocks on a runtime that's installed but
  fails its check, reported apart from one that's missing; `rig up`'s preflight fails a Claude, Codex or OMP check that
  doesn't answer (a warning for Pi).
- **Claude login detection:** only a current refusal reads `login_required`, not the "Not logged in" footer alone.
- **Model pins:** `fable` now names `claude-fable-5-1`, a trailing `[1m]` is set aside, and pinned Pi seats are checked
  (a `:high`-style thinking suffix is accepted).
- **A custom permission policy saved with CRLF line endings** now takes effect at the next launch or restore, instead
  of the advisory floor.
- **`rig scope mission create`** writes `status: planned`; set it `active` to count it in `rig proof show --project`.
  With `--workspace <project>`, missions go under the project's declared `missions.root`.

## Sends, wakes and the queue

- **A send to a pane in tmux copy or view mode** leaves the mode and delivers; `pane_in_mode` means the pane couldn't
  leave its mode. Leave it in that pane, then send again.
- **`rig send --dangerously-interact` types exactly what you give it.** Enter is added only for a complete answer
  staged in a recognised Claude Code or Codex input box; anywhere else, put CR in the payload. With `--verify` it reads
  unchecked.
- **A Codex seat reads "needs you" only when a real prompt is visible;** a pending permission request reads
  `permission_request_pending` first, and an unreadable pane gets `permission_request_unverified` after a grace.
  Codex's `»` prompt is recognised.
- **Managed `/compact` is short enough to run and is sent only to an idle seat.** Confirm compaction by effect: the
  restore request, or the drop in context.
- **A held-back (`retained`) wake doesn't use up a one-shot park timer;** it's tried again at the interval. You don't
  need to re-arm after one.
- **A retired watchdog doesn't deliver a late wake.** A row parked on its owner's own repeating reminder reads
  `servedByOwnReminder` in `rig parked` and draws no extra parked-owner wake.
- **`rig queue update <id> --summary "<text>"`** alone corrects a row's subject. Close with **`--resolution
  "<outcome>"`** to store the outcome on the row.
- **`rig remove` and `rig shrink`** keep a seat that gets work while stopping (409, `retained: true`) unless
  `--fallback` takes it. A stale `rig unclaim` is refused with `session_not_current`.

## New things you can do

- **Set one seat's reasoning effort:** `rig seat set-effort <seat> --effort <level> --reason "<why>"` (or `--clear`); it
  applies at the next managed launch, not to the running process. Check it with `rig seat effort <seat>`.
- **Change a seat's stored permission policy:** `rig policy apply <policy> --seat <seat> --reason "<why>"`. `rig policy
  current` and plain `rig ps` don't show it; `rig seat status` does.
- **Give seats environment values:** `env:` on the rig or a member in `rig.yaml`, or `rig up <spec> --env KEY=VALUE` for
  one launch. Never put secrets there.
- **Scope a workflow run:** `--project`, `--mission`, `--slice` and `--tags` on `rig workflow instantiate` and `run`;
  write a target as `member@{rig}` to follow the bound rig.
- **Read cost:** `rig usage cost [--seat <session>] [--json]`. A missing figure is never $0, and Claude's figure is an
  estimate, not an invoice.
- **Hand work over without a shell:** `rig mcp serve` with `OPENRIG_SESSION_NAME` set gives `rig_queue_create`,
  `rig_queue_show`, `rig_queue_list`, `rig_queue_claim` and `rig_queue_update`. Nothing wakes that agent.
- **`rig status --json`:** treat `daemon.reachable: null` as unconfirmed, not down.
- OpenRig 0.6.12 adds `rig community-harness list` for installed community-harness presets, showing their maintainer
  and declared limits. These harnesses are not tested by OpenRig. Support is launch-only: no resume or fork, no
  resource projection or startup-file delivery, and identity remains unconfirmed. A quiet screen is not proof that the
  seat is idle. (#1392, #1518)
- **Guidance:** the `rigs` skill offers to join the team before the first operator message, and offers Codex users one
  removable rules file; `delegating-work` says to brief a peer by the model `rig ps --nodes --json` shows; the operator
  reads `$OPENRIG_HOME/reference/keeping-a-watch.md` when asked to watch or remind, including a low-allowance warning.
- User-visible text says "harness" for the agent software around a model, and "community harness" for one an outside
  contributor maintains; `docs/reference/topology-naming.md` defines the terms. (#1506)

## Off by default

- **`output.compact`** now also shortens `rig queue show` and `rig queue transitions` (`--full` for everything) and
  bounds `rig whoami --json` peers to `output.whoami_peers` (`--all-peers` lists all).
- **`provider.usage_windows`** now also shows Claude's windows, each seat's configured account and, with
  `--all-hosts` or `--hosts`, every registered machine's windows. A Claude account's current availability always reads
  `unknown`: don't tell a person an account has room from a seat's reading.
- **`usage.pi_cost_facts`** and **`usage.pi_openrouter_charge`** take effect when a Pi seat next launches or resumes, not
  at once; what was recorded stays visible after they're turned off.
- **`provider.subscription_moves`** enables `rig provider moves`. The `openrig-user` skill's section for it mentions apps
  that don't ship in this release.
- **`bundle.services_enabled`**, **`transport.verify_input_box`**, the per-seat draft-aware typing guard (`rig seat
  set-typing-guard <seat> --mode draft-aware`), `rig bundle create --include-login-files`, `OPENRIG_TMUX_CONTROL=1`
  and `OPENRIG_REFOCUS_BUDGET_MS` (4500 to 52000) each act only when chosen.
- **The daemon runs tmux without `/bin/sh`** on Linux and macOS; `OPENRIG_TMUX_SHELL=1` at daemon start keeps the old
  path.

## What to stop doing

- **Stop looking up a rig's ID before `rig launch`;** the name works.
- **Stop expecting `rig start --last` to bring back a rig taken down on purpose;** use `rig start --rigs <rig>` or `rig
  up '<name>' --existing`.
- **Stop counting on `--dangerously-interact` to press Enter;** put CR in the payload.
- **Stop taking the preparation prompt's delivery as the compaction's result;** read the `compact` result and confirm by
  effect.
- **Stop answering `--fresh` for an ordinary terminal seat on every restore.**
- **Stop branching on exit 2 for a fixable `rig queue update` refusal;** it's exit 1.
- **Stop recreating a seat, or editing the database, to change its permission policy;** use `rig policy apply --seat`.

## Known gaps in 0.6.12

- **Managed compaction's 600-character budget** rests on one comparison on Claude Code 2.1.282, and nothing confirms
  compaction ran.
- **The plugin hooks haven't run through this path in a real session,** and two hook runs for one seat aren't
  serialized: a post-compaction record can be lost or a refocus delivered twice.
- **One Slack app across machines was simulated in one process,** never run on two real machines. Relayed events are
  trusted from the calling daemon, and `rig slack verify` on the hub doesn't check relayed channels.
- **`env:` values aren't secret,** and members added with `rig grow` can't carry a member-level `env:`.
- **`rig up --env` is not forwarded for flat-node specs or v1 bundles,** although the launch may succeed. Do not rely on
  the flag for those formats in this release.
- **The draft-aware guard waits for idle inside the seat's delivery lease,** which can delay other work for that seat.
- **With `bundle.services_enabled` on, `rig up <file>.rigbundle` installs into the current folder** when no `--target` is
  given.
- **`rig seat restart --keep-conversation` supports Linux only,** and hasn't been re-run on 0.6.12.
- **The rig status API can call a running rig `blocked`** because of one seat that isn't running: it folds a restore
  forecast into current status.
- **A Codex seat can keep reading as at its usage limit** in a constructed screen case not seen in a real session.
- **After `rig scope slice create` says it couldn't verify membership, the slice was kept.** Check `mission.yaml` before
  creating it again.
- **A Claude Code seat whose permission request was approved automatically can still read "needs input";** the Codex
  case is fixed.
- **Codex team seats aren't asked before lifecycle commands yet.**
- **The send gate trusts the most recently recorded hook;** `rig capture` shows the real screen.
- **A launched team still writes into its working folder;** the operator says what changes before you agree.
- **After a restart, `rig status` shows `Kernel: skipped` whatever the kernel seats' state.** Read them with
  `rig ps --nodes --rig kernel --full`.
- **`rig tui --shared` still attaches on the default tmux server,** so use `rig tui` when the daemon runs on a non-default
  tmux socket.
