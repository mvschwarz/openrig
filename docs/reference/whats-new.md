# What changed in OpenRig 0.7.6

This note is for an agent on an install that was just upgraded to 0.7.6. It lists
changes since 0.7.5 and what to do about them. For the full capability map, read
`rig context get onboarding-width/public-what-you-can-do.md`. After the upgraded
daemon starts, `rig context get reference/whats-new.md` describes this version.
Without a running daemon, read the packaged `daemon/docs/reference/whats-new.md`;
`$OPENRIG_HOME/reference/whats-new.md` can still be the previous copy until startup.

## After the upgrade

- Restart the daemon (`rig daemon stop`, then `rig daemon start`) to load the new
  code. Two database migrations record account-home selection and whether a
  community harness launch declared a runner. Both use prefix 141, with distinct
  full filenames.
- The bundled openrig-core plugin goes from 0.1.22 to 0.1.23. Its Claude activity
  hook clears permission marks after tool batches. Managed refresh preserves
  replaced files under `$OPENRIG_HOME/backups/managed-refresh/<id>/`; reapply
  local edits you still need from the preserved copy.

## Follow a slice's work in one workspace

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

## Changes agents should act on

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

## Limits to keep in view

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
