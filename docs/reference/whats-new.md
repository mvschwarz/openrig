# What changed in OpenRig 0.7.9

This note is for an agent on an install that was just upgraded to 0.7.9. OpenRig
0.7.9 records default runner permits, passes a person's typed words to the
agent, turns stream intake on by default, and moves guidance for fresh Pi seats,
and fresh Codex seats on 0.164.0 or later, out of the repository's `AGENTS.md`.
If you upgraded from 0.7.7 or
earlier, also read "What changed in OpenRig 0.7.8" below. For the full
capability map, read `rig context get onboarding-width/public-what-you-can-do.md`.
After the upgraded daemon starts, `rig context get reference/whats-new.md`
describes this version. Without a running daemon, read the packaged
`daemon/docs/reference/whats-new.md`; `$OPENRIG_HOME/reference/whats-new.md` can
still be the previous copy until startup.

## After the upgrade

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

## Runner seats

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
  has no destination and never changes the permit; with stream intake on, it also
  reaches the queue worker's intake row, like any stream item.
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

## OpenShell workers

0.7.9 includes a repair for the OpenShell worker that wasn't usable in 0.7.8,
but it hasn't run end to end in our release testing. Don't rely on this path in
0.7.9. Startup now reaches the guest through a hash-checked first-input file,
and nothing is typed through the host viewer. Readiness checks the guest's own
execution, and a failed owned delete reports the stage that failed. If you set
one up anyway, follow `daemon/assets/openshell/README.md` in the installed
package, rebuild the guest image first, and name the costs to the person
("Provider registration and image construction can incur costs"). "Never grant
the guest access to the daemon's main API port (normally 7433)."

## Assistants connected through a grant service (experimental)

Experimental, unsupported, off by default, and at the person's own risk. With
`rig mcp serve --http --grant-service <url>` and a grant service the person
supplies and runs, a connected assistant can claim, update and park the rows
addressed to its own seat, and see its team with `rig_team`, within the scope its
existing tools have. Nothing wakes it: an item stays queued until its receiver
claims it. Name the outside service, and the exposure of serving MCP over HTTP,
to the person before you set this up. `docs/reference/hosted-members.md` is the
rule.

## Other changes to act on

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

## Limits to keep in view

- **OpenShell** hasn't run end to end in our release testing (above). A
  same-generation reconciled launch opens no viewer, so run
  `rig environment connect` yourself; non-text startup actions aren't supported
  on environment seats.
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
- **Codex hooks after an upgrade:** Codex sessions kept open across the 0.7.8
  upgrade showed "Hook failed — plugin contents changed; hook approval
  required". The 0.7.9 behaviour, and hook recovery after a relaunch, haven't
  been verified.
- **0.7.8's limits** on the dsh `env:` names, conformance false failures, typed
  words, the README's operator address, a symlinked rebuild, the rebuild receipt,
  a re-parked click and unrecorded default permits are fixed or changed. The
  other 0.7.8 and 0.7.7 limits below, and the
  [0.7.6 limits](https://github.com/mvschwarz/openrig/releases/tag/v0.7.6), still
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
0.7.8; 0.7.9's repair is described above.

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

- **No harness has run end to end under the runner contract yet.** The dsh
  example and the conformance check were checked against stand-ins.
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
- **The 0.7.7 limits below, and the [0.7.6 limits](https://github.com/mvschwarz/openrig/releases/tag/v0.7.6), still apply.**

---

## What changed in OpenRig 0.7.7

The changes from 0.7.6 to 0.7.7, a reliability patch for 0.7.6, published on
2026-11-02. All three fixes are in 0.7.8.

### The fixes

- A Claude seat at an empty prompt reads idle again when Claude prints
  "✔ Update installed · /restart to apply" (or "Restart to apply") below its mode
  bar after installing an update. Before, that line hid the mode bar, so the seat
  read unknown and managed compaction waited for an idle prompt it could not see.
  Both spellings are recognized; lines that only look similar still read unknown.
  ([#2311](https://github.com/mvschwarz/openrig/pull/2311))
- Managed compaction checks the input box before it pastes its preparation
  prompt, `/compact` or a restore prompt, even with the typing guard off. Typed,
  unreadable or changed input holds that step. A manual `rig compact` then says it
  stopped to preserve the input box; read `rig compact <seat> --state` and retry
  once the box is empty. A held restore prompt waits and goes ahead on its own once
  the box is empty. An empty box or a high-confidence suggestion goes ahead.
  Ordinary `rig send` and the typing-guard defaults are unchanged.
  ([#2347](https://github.com/mvschwarz/openrig/pull/2347))
- A Claude seat whose `claude` is a `#!` wrapper that starts the real Claude without
  `exec` can be rebuilt again (`rig seat handover --source rebuild`): readiness also
  accepts the wrapper's direct child when it names this launch's conversation token,
  and refuses every other process as before. A rebuild that fails no longer leaves
  the seat's resume target on the new, unprimed conversation.
  ([#2341](https://github.com/mvschwarz/openrig/issues/2341), [#2354](https://github.com/mvschwarz/openrig/pull/2354))

### Limits to keep in view

- Other reasons managed compaction can wait are unchanged.
- The input-box check is a read just before the paste, not a lock: typing that
  starts in the same moment can still be appended to.
- If a seat's current occupant generation was never registered (an adopted Claude
  with another generation, or a managed launch whose tenure record failed to write),
  hooks don't move its resume token after the first one.
- The [0.7.6 limits](https://github.com/mvschwarz/openrig/releases/tag/v0.7.6) still apply.
