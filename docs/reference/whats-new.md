# What changed in OpenRig 0.7.10

This note is for an agent on an install that was just upgraded to 0.7.10. OpenRig
0.7.10 adds `rig exec` for finite runs on Claude Code or Codex (not yet run with
a real adapter), sends a held
post-compaction step after two idle polls that can't read the input box, leaves
every tmux mode before a delivery, and shows agent spec advisories at launch. It
fixes in the source the two problems that stopped the OpenShell worker in 0.7.9,
but that worker hasn't run end to end. If you upgraded from 0.7.8 or earlier,
also read "What changed in OpenRig 0.7.9" below, and from 0.7.7 or earlier,
"What changed in OpenRig 0.7.8" too. For the full capability map, read
`rig context get onboarding-width/public-what-you-can-do.md`. After the upgraded
daemon starts, `rig context get reference/whats-new.md` describes this version.
Without a running daemon, read the packaged `daemon/docs/reference/whats-new.md`;
`$OPENRIG_HOME/reference/whats-new.md` can still be the previous copy until
startup.

## After the upgrade

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

## Finite runs: `rig exec`

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

## Compaction and delivery

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
- **Herdr views kept across an upgrade keep working,** on Linux Herdr 0.9.5 /
  protocol 22. A viewer or follow view kept from 0.7.5 through 0.7.9 now counts
  as the same attachment when only OpenRig's tile script changed, and moves to
  the current command, so the viewer stays confirmed and the follow view goes on
  adding and closing tiles. A kept viewer that's already running keeps its
  earlier sizing until it's attached again; writable viewers opened after the
  upgrade size their pane. A different session, tmux, server or read-only
  setting still holds the view, as before. Checked against the scripts those
  releases used, not yet with a live Herdr. It follows @natefaerber's approach in
  [#2467](https://github.com/mvschwarz/openrig/pull/2467). ([#2634](https://github.com/mvschwarz/openrig/pull/2634))

## OpenShell workers

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

## Other changes to act on

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

## Limits to keep in view

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
- **Codex seats can still report `rig: command not found`** when `rig` isn't on
  the login shell's PATH: with Node outside it, or after a project-local
  install. Preflight warns at launch; `getting-started.md` explains the
  `~/.profile` line and how to check it with `bash -lc 'command -v node rig'`.
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
  held after compaction, `rig broadcast`'s `FAILED`, and what has run under the
  runner contract are fixed or changed. The 0.7.8 limits below that 0.7.9
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

## What changed in OpenRig 0.7.8

The changes from 0.7.7 to 0.7.8, published on 2026-11-05, for an install
upgrading from 0.7.7 or earlier.

### After the upgrade

- **Restart the daemon** to load the new code: `rig daemon stop`, then
  `rig daemon start`.
  - **Migrations 142 to 145** store a Claude seat's MCP opt-out, seat activity
    grants, OpenShell environment bindings and a seat's chosen permission person.
- **The bundled openrig-core plugin goes from 0.1.23 to 0.1.24.** One skill line
  changed. Managed refresh preserves replaced files under
  `$OPENRIG_HOME/backups/managed-refresh/<id>/`; reapply local edits you still
  need from the preserved copy.

### Runner seats: a person answers permission requests

Section 7 of `docs/reference/harness-runner-contract.md` is the rule. Read it
before writing or changing a runner.
- **Who is asked:**
  - **the default person** (`rig gateway default`, or the only registered
    person) gets an ordinary ask in the Feed and on Slack;
  - **a chosen person,** after
    `rig seat set-permissions-to <seat> --to <person> --reason "…"`. `--clear`
    returns to the default;
  - **no one:** when no one can be asked, the request is "Permitted at once,
    with the agent's own allow option";
  - **refusal** is opt-in, with `--deny`. `rig seat status` shows the choice.
- **What a person's answer does:** a click gives that option, a plain yes gives
  the allow, and a plain no gives the reject. "A person's no is never a grant."
  An unanswered request stays pending until the agent's turn ends.
- **The runner's protocol:**
  - `POST /api/activity/permission-requests` submits the request;
  - `GET …/<askId>?waitSeconds=25` reads the answer (25 at most);
  - `POST …/<askId>/withdraw` withdraws it at the turn's end.

  Deliver an answer once, only to the live request.
- **Check a runner** with
  `node daemon/docs/reference/runner-conformance/check-runner.mjs --runner '<command with {agent}>' --name <harness>`
  from the installed package. It needs Node and tmux, and no daemon, model or
  network.
- **The worked example** is the dsh runner under
  `daemon/docs/reference/community-harness-examples/dsh/`.
- **A seat activity grant** lets a runner outside the host's hook setup report
  activity for one seat and launch, without the install-wide hook token.

### OpenShell workers

0.7.8 includes `rig environment` (`setup`, `create`, `attach`) and a reference
for binding a seat to an NVIDIA OpenShell sandbox (`daemon/assets/openshell/README.md`).
**In our release testing the worker never became usable:** after the sandbox was
created and the native process started, `rig environment connect` failed when its
check timed out after 5 seconds, so no team work ran. Don't rely on this path in
0.7.8; the later repairs are described above.

**What it needs:**
- NVIDIA OpenShell 0.1.6;
- a Linux image;
- an API-backed provider using `ANTHROPIC_API_KEY`. Subscription or OAuth
  credentials aren't supported.

"Provider registration and image construction can incur costs", so name them to
the person before you start. "Never grant the guest access to the daemon's main
API port (normally 7433)."

### Other changes to act on

- **Mission following:** `rig terminal open mission:<id> --follow --provider herdr`
  follows a mission's current owners, with the same Herdr path as slices.
- **Launch choices:**
  - `claude_mcp: none` on a Claude member launches it without MCP servers;
  - `rig config set terminal.tmux_server isolated` gives this OpenRig home its
    own persistent tmux server.
- **Hosts:** `rig host edit` and `rig host remove` correct or retire a host
  entry. Use them instead of editing `hosts.yaml` by hand.
- **Another user's daemon:** when `rig doctor` warns that the port is held by
  another OS user's daemon, follow its fix (`rig config set daemon.port <free-port>`),
  or set `OPENRIG_URL` to share that daemon on purpose.
- **tmux control mode:** with `OPENRIG_TMUX_CONTROL=1`, OpenRig starts a control
  client only on tmux 3.7c or newer, and uses spawned clients otherwise.
- **Read-only tmux clients:** a submit key refused because of one goes through
  the paste route.
- **Slack:** a typed reply to a decision parked on its person is recorded as the
  answer. Read the person's words; don't treat the close as approval.
- **The TUI:** agent pages now show health findings and recently finished items,
  and an agent spec's "not loaded in this view" means it wasn't read, not that
  nothing runs it.

### Limits to keep in view

- ~~**No harness has run end to end under the runner contract yet.** The dsh
  example and the conformance check were checked against stand-ins.~~ *Corrected
  after release:* 0.7.8's release testing ran a real dsh 0.2.1-rc.2 through the
  shipped dsh example runner for a person's allow-once and reject-once, and
  through an outside runner, dsh-seat 0.3.0, for launch, queue work, multiline
  input, activity, cancel and exact resume. The conformance check itself runs
  against a stand-in agent.
- **The answer owner is a registered person,** and a colleague's answer is
  followed on this host only. A request handed to another host waits as needs
  input until the turn ends.
- **Permits and answers aren't recorded** beyond the runner's pane and the ask.
  If the agent offers only `allow_always`, a permit makes its harness remember a
  permission nobody chose.
- **Coming as follow-ups:** recording permits made when no one can be asked, and
  passing typed words that aren't a plain yes or no to the agent.
- **The dsh example keeps one hold per seat:** two asks in one turn can leave one
  waiting after the hold is released.
- **An OpenShell worker's activity reads unknown,** sampled from the pane, never
  idle.
- **The [0.7.7](https://github.com/mvschwarz/openrig/releases/tag/v0.7.7) and
  [0.7.6](https://github.com/mvschwarz/openrig/releases/tag/v0.7.6) limits still apply.**
