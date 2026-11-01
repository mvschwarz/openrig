# What changed in OpenRig 0.7.8

This note is for an agent on an install that was just upgraded to 0.7.8. OpenRig
0.7.8 lets a community harness's runner have its agent's permission requests
answered by a person, adds a maintained OpenShell path for Claude workers, and
includes 0.7.7's three reliability fixes. If you upgraded from 0.7.5 or earlier,
also read "What changed in OpenRig 0.7.6" below. For the full capability map,
read `rig context get onboarding-width/public-what-you-can-do.md`. After the
upgraded daemon starts, `rig context get reference/whats-new.md` describes this
version. Without a running daemon, read the packaged
`daemon/docs/reference/whats-new.md`; `$OPENRIG_HOME/reference/whats-new.md` can
still be the previous copy until startup.

## After the upgrade

- **Restart the daemon** to load the new code: `rig daemon stop`, then
  `rig daemon start`.
  - **Migrations 142 to 145** store a Claude seat's MCP opt-out, seat activity
    grants, OpenShell environment bindings and a seat's chosen permission person.
- **The bundled openrig-core plugin goes from 0.1.23 to 0.1.24.** One skill line
  changed. Managed refresh preserves replaced files under
  `$OPENRIG_HOME/backups/managed-refresh/<id>/`; reapply local edits you still
  need from the preserved copy.

## Runner seats: a person answers permission requests

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

## OpenShell workers

`rig environment setup` installs a reference that binds a seat to one NVIDIA
OpenShell sandbox. Then use `rig environment create` (or `attach`), `rig up`, and
`rig environment export` for verified JSON results. Stopping the agent, stopping
compute and deleting an owned sandbox are separate actions. A recreated sandbox
can resume the same conversation from a checkpoint. Follow
`daemon/assets/openshell/README.md` in the installed package.

**What it needs:**
- NVIDIA OpenShell 0.1.6;
- a Linux image;
- an API-backed provider using `ANTHROPIC_API_KEY`. Subscription or OAuth
  credentials aren't supported.

"Provider registration and image construction can incur costs", so name them to
the person before you start. "Never grant the guest access to the daemon's main
API port (normally 7433)."

## Other changes to act on

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

## Limits to keep in view

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
- **The 0.7.7 and 0.7.6 limits below still apply.**

---

## What changed in OpenRig 0.7.7

The changes from 0.7.6 to 0.7.7, a reliability patch for 0.7.6 that isn't
published yet. All three fixes are in 0.7.8.

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
- The 0.7.6 limits below still apply.

---

## What changed in OpenRig 0.7.6

The changes from 0.7.5 to 0.7.6, for an install upgrading from 0.7.5 or earlier.

### After the upgrade

- Restart the daemon (`rig daemon stop`, then `rig daemon start`) to load the new
  code. Two database migrations record account-home selection and whether a
  community harness launch declared a runner. Both use prefix 141, with distinct
  full filenames.
- The bundled openrig-core plugin goes from 0.1.22 to 0.1.23. Its Claude activity
  hook clears permission marks after tool batches. Managed refresh preserves
  replaced files under `$OPENRIG_HOME/backups/managed-refresh/<id>/`; reapply
  local edits you still need from the preserved copy.

### Follow a slice's work in one workspace

Use `rig terminal open slice:<name-or-id> --follow --provider herdr`. Membership
comes from pending, in-progress and blocked queue rows tagged with the exact
slice. Associate a row with `rig queue create --slice <name-or-id>`; a handoff
inherits its tags unless replaced. A mission-only tag does not associate every
slice. One owner appears once, with all its obligations listed.

When a slice's folder name repeats across missions, tag its work with the slice's
unique ID (`rig queue create --slice <id>`) or add `--mission <mission>`. A row
tagged only with the shared name cannot be placed, so the view reads incomplete
until it is.

New slice views default to four automatic tiles (`--max-tiles` overrides it);
qitem views keep eight. A known empty slice stays following and can repopulate.
An incomplete read keeps the prior viewers. Missing or ambiguous scope identities
are errors, never an empty team. Pins, drafts, unknown input and focus retain
former viewers. Closing a viewer does not stop its agent.

An owner's join refused before any pane split can join on a later refresh;
hold notices keep the original seat, phase and reason. A created viewer whose
attach has not yet run can continue without replacing its pane. A viewer whose
attach already ran and then exited back to a shell is not restarted
automatically, so the whole slice view can hold until that tile is resolved.
No tested workaround is offered for that case.

Slice following targets the Linux Herdr 0.9.5 / protocol 22 path. Mission
following is not included. See
`reference/terminal-sessions.md` for controls, bounds and refresh behavior.
Configured Herdr session endpoints now carry through viewer/follow operations.
The TUI's terminal action opens the agent, pod or rig currently being viewed.

### Changes agents should act on

- **A readiness deadline does not end a still-starting daemon.** A nonzero
  pending result names the child PID, launch endpoint and log. The child stays
  running and the startup reservation stays in place; readiness is not
  confirmed. Follow the returned pending guidance before attempting recovery.
- **Read exited state honestly.** A verified exited process in a retained pane
  reads `pane_exited`, instead of running and ready. Its outstanding work uses
  the existing recovery-finding route. Unknown observations still mean unknown.
- **Use the same member settings when expanding.** `rig expand` now carries raw
  members to the canonical rig validator, keeping env, effort and startup
  settings. Restores keep the model saved with `rig seat set-model`.
- **Account-home moves start a fresh conversation with a handover.**
  `rig provider switch --seat <seat> --to-account <name> --account-home <dir>`
  selects an existing home; preview with `--dry-run`. `--clear-account-home`
  returns to configured defaults, not historical credentials. Check the moved
  seat's account and conversation.
- **Claude API-key switching resumes the same conversation but interrupts work.**
  Use `rig provider switch --seat <seat> --to-account api --api-key-file <abs>`;
  return with `--to-account plan --token-file <abs>`. The API-key path remains
  unqualified. Do not combine it with account-home selectors. Credential files
  stay private; budgets remain the caller's responsibility.
- **A new Claude member can name its subscription token in the spec:**
  `claude_token: {label: name, file: /abs/token}`, beside its own
  `env.CLAUDE_CONFIG_DIR`. This stores a file reference, not the token. Validation
  does not read the file; a missing or unreadable token uses the existing launch
  fallback notice, so verify the account actually used.
- **Git over SSH uses the daemon's SSH agent** in managed seats. Make sure that
  agent has the intended key (`ssh-add -l`).
- **Slack button answers resume decisions parked on the person asked.** Set
  `rig slack setup --reactions off` if acknowledgement emoji should not wake
  agents. The default remains `route`; manifest regeneration preserves it.
  Replies posted outside a deleted Slack thread are tracked where Slack put them.
- **Queue delivery keeps its original intent.** A wake refused at a selection
  prompt retries after it clears. Cross-host `queue create --verify` reads the
  destination's receipt. An unreadable receipt stays unconfirmed; do not replay
  a create just because verification could not establish delivery.
- **Preset authors can opt into `runner: true` and `passes_model: true`.** The
  runner also requires `launch_result: true` and reports activity through the
  existing hook route. Model input arrives as `OPENRIG_MODEL`. Passed means the
  launch command was sent, not that the harness applied that model; the observed
  model remains unknown. Cursor and Hermes examples leave model passing off
  pending native qualification.
  Start with the draft [integration author contracts](author-contracts.md) for
  harness, runner and platform duties, with implemented interfaces distinguished from proposals.
- **Update viewer API handling.** `/api/terminal/viewer/ensure` returns 400 for
  `view_required` and `unknown_provider` where it previously returned 200 with
  an error body. Slice not-found is 404; ambiguous/unavailable is 409. Continue
  reading the body code. Unsupported follow kinds keep `follow_view_required`
  in a 200 `ok:false` response.

### Limits to keep in view

- The reported [Codex hook-refresh refusal (#2200)](https://github.com/mvschwarz/openrig/issues/2200)
  remains unresolved. A verified Node-launcher fix is included, but that does
  not establish that this report is fixed. If
  `rig seat restart <seat> --keep-conversation` refuses, nothing is stopped:
  leave the seat running and report the refusal with CLI and daemon versions.
  A refused restart has not refreshed hooks; review any Codex hook prompt.
- Retained messages are not delivered. Protected Codex pastes and unreadable
  composers can still retain work; inspect the explanation, use a larger pane
  or shorten the message. Turning the typing guard off removes protection.
- Inventory now avoids redundant reads, but no general speed or stability
  improvement is claimed without comparable measurements.
- Internet-facing hosted members remain experimental, unsupported, off by
  default and at your own risk. Slice following does not require them.
