# What changed in OpenRig 0.7.4

This note is for an agent on an install that was just upgraded to 0.7.4. It lists only what behaves differently from
0.7.3 and what to do about it. For everything OpenRig can do, read the capability map:
`rig context get onboarding-width/public-what-you-can-do.md`. Each release replaces this file, so
`rig context get reference/whats-new.md` describes the installed version once the upgraded daemon is running. Without
a running daemon, read `$OPENRIG_HOME/reference/whats-new.md`. The daemon refreshes that copy when it starts, so right
after an upgrade it can still hold the previous version's note.

## After the upgrade

- **Restart the daemon** (`rig daemon stop`, then `rig daemon start`). One migration runs on the first start (140). It
  adds a nullable `identity_principal` column, empty on earlier rows, to queue transitions and their archive, inbox and
  outbox entries, and stream items. Going back to 0.7.3 leaves the column in place, unread.
- **The bundled openrig-core plugin goes from 0.1.20 to 0.1.21.** The `queue-handoff` skill gains a paragraph on writing a
  handoff that can be acted on after one read, and the Claude hooks add `StopFailure`, which reports a stop caused by a
  rate limit. As before, startup first copies each file it replaces under `$OPENRIG_HOME/backups/managed-refresh/<id>/`,
  edited or not, and logs where. A copy doesn't mean anyone edited the file; if someone did, reapply the change from
  the copy.
- **Claude seats get the new hook at their next launch, resume, restore or handover,** not in a running process.
- **Codex seats:** OpenRig's Codex plugin is openrig-core, so Codex sees it as changed. As before, OpenRig renews its own
  hook approval only where the installed plugin folder matches what shipped. If a Codex seat stops at Codex's "Hooks
  need review" after the upgrade, review the hooks in Codex.
- **No setting is added or removed.**

## New things you can do

- **Put an assistant that lives outside a terminal on a team:** add a roster entry for its seat with `"hosted": true`
  and connect the assistant to `rig mcp serve` under a grant for that seat (`rig mcp token add <name> --seat
  <member>@<rig> --rig <rig>`, or a grant service, below). `rig_team` then lists it as a hosted member with its declared
  capabilities and caveat, no pane, and activity `unknown`; `rig roster show` and `find` say it's hosted. The server's
  instructions teach it the loop (inbox, claim, close or hand on, and asking a person while keeping the item), and it
  can call `rig_whoami` to learn its seat.
- **Ring a hosted member when work lands for it:** declare `wake.webhook` on its roster entry, with `url_ref`,
  `authorization_ref` and optionally `secrets_env_file` (an absolute path to a 0600 env file). The refs are secret names
  read from the daemon's environment or that file; never put values in a roster. OpenRig POSTs `{source, schema_version,
  event: "work-waiting", qitem_id, destination, summary, from}`, never the row's body, waits up to 10 seconds and
  doesn't follow redirects.
- **See when a hosted member last showed up:** `rig_team` shows its last call to the team's MCP server and its latest
  ring with how that went; `rig roster show` and `find` show the last call.
- **Check remote callers with an external grant service:** `rig mcp serve --http --grant-service <url>`, with
  `--grant-service-header-file <path>` for one `Name: value` header on each lookup. Each request is checked; nothing is
  cached.
- **Let OAuth clients discover how to sign in:** add `--oauth-resource <url>` (the public https URL clients reach, its
  path ending in `/mcp`) and `--oauth-issuer <url>` to `--grant-service`. The server publishes OAuth protected-resource
  metadata (RFC 9728) and answers a missing or bad credential with a standard challenge.
- **Serve newer MCP clients:** clients on protocol revision 2026-07-28 (no `initialize`, the version on every request,
  possibly opening with `server/discover`) work with `rig mcp serve` over stdio or `--http`, beside clients on the 2025
  revisions, on the same endpoint.
- **List the conversations a seat could resume:** `rig seat history --rig <id> --node-id <id>` (`--json`), read-only and
  without native tokens; `--snapshot-id <id>` with `--history-session-id <id>` checks one reference it returned. The IDs
  are `rigId` in `rig ps --nodes --json` and `identity.nodeId` in `rig whoami --session <seat> --json`. A client can then
  ask the daemon's startup review for that node to resume the history the person reviewed.
- **Preview or open a task's current owners:** `rig terminal open qitem:<id>`; the daemon's preview,
  `GET /api/terminal/preview?view=qitem:<id>`, returns the same view without opening it.

## Behaviour that changed

- **The kernel at daemon start:** startup restores a kernel only when this start's reconcile found its seats down (what
  a reboot leaves). A kernel that was already down before this start stays down. `rig start` prints `Kernel auto-boot
  skipped: kernel rig already managed; it was already down before this daemon start, so it was not restored. Bring it
  back with: rig up kernel --existing`.
- **`rig daemon start --wait-for-kernel`** for a kernel skipped on purpose prints the same reason and way back that `rig
  start` gives, instead of "did not reach ready / partial_ready within …ms" and a runtime-auth fix. It still exits 1. A
  kernel still booting at the deadline, and the failure states, keep their wording.
- **Work waiting for a member nothing can wake** is reported to that member's person (Steering, the TUI's Feed, and Slack
  under the default subscription), not to the member.
- **A rung hosted member that doesn't claim its work** by the stuck sweep's unclaimed age is reported to its person, as
  for a member with no trigger.
- **A caller granted through a grant service** can address only its granted team, not its own or another caller seat,
  and can't set OpenRig's Slack provenance tags or a workflow's internal sign-off.
- **A caller's seat that was created but never launched** is served by `rig mcp serve --http` instead of refused with
  `seat_unavailable`.
- **A park on a registered person's own address** (`<id>@external`) resolves only from a Slack reply written after its
  question; it keeps `--summary` and `--evidence-ref`; and it shows in NEEDS YOU in the reviews, with asks to that
  address.
- **The reviews' agents band** counts only open rows as held, and a seat with work in progress reads as working.
- **A Claude seat stopped by a rate limit** is recognised from the `StopFailure` hook, and a delayed older Claude hook no
  longer replaces a seat's current state.
- **`rig handover --source fresh` on Claude** reports delivery only when the packet is submitted, and fails with
  `context_delivery_failed` if it's still staged after one retry.
- **A periodic snapshot** between separate named-agent launches keeps a down agent's resume source.
- **A resumed Pi seat** no longer prints `Entry not found` after `READY` on every restart.
- **The TUI** starts in a terminal that reports 0 rows or columns, lists rigs by name as `rig ps` does, and no longer
  reports a refused effort read as a failure.
- **Identity lookup** (`rig whoami`, `rig down`, `rig ask`, `rig health`) no longer prints tmux's `invalid option` errors.
- **An artifact whose frontmatter isn't closed** no longer wakes an artifact-pool worker as ready.

## Output that changed shape

- **`rig_team`** can carry hosted members (activity `unknown`, their capabilities, caveat, last call and latest ring)
  and `hostedMembersNote` when a roster can't be read.
- **Terminal preview and open responses** carry `viewDescriptor` (`kind`, `name`).
- **Rows written by a granted MCP caller's actions** carry `identity_principal` (`principal:v1`: source, id and, for a
  grant service, grant and version).
- **A webhook ring** is recorded on the row as `wake-accepted:webhook (<url_ref>) answered <status>` for a 2xx.
- **`rig seat history`** is new, with `--json`.

## What to stop doing

- **Don't launch a remote caller's seat just to give it a session.** A created seat is served.
- **Don't read a webhook ring's 2xx as the member waking.** Its claim on the row is the pickup.
- **Don't read a hosted member's `unknown` activity as idle.** OpenRig doesn't observe it between calls.
- **Don't expect a long-gone kernel to come back on daemon start.** Run `rig up kernel --existing` when you want it.
- **Don't read `--wait-for-kernel`'s exit 1 for a skipped kernel as an auth problem.** Read the reason it prints.

## Known gaps in 0.7.4

- **A webhook ring proves only that the endpoint accepted it.** An ordinary chat app can't receive unsolicited events,
  so a hosted assistant without a webhook-capable runner sees work only when it checks.
- **A recorded principal is attribution, not authentication.**
- **The `qitem:<id>` view is membership only:** it doesn't follow the task as it moves, keep a reusable viewer, or grant
  input. An explicit open still has the provider's usual workspace effects.
- **Resuming a reviewed history has no CLI yet;** it's through the daemon's startup review, for clients, and limited to
  this node's eligible Claude and Codex histories in the current compatible snapshot.
- **The kernel's restore evidence lasts one daemon process:** if the first daemon after a reboot exits before the
  kernel's restore starts a seat, the next start leaves the kernel down and says so.
- **OpenClaw's interrupted local turns aren't recovered** (#2092). Capture the pane before sending; for an unattended
  seat, use the Gateway preset.
- **Whether processes a community harness starts outside its pane survive isn't exercised** (#2088), and `rig down`
  stops the pane only (#2077).
- **Hermes:** the preset doesn't declare `resume`, and whether a seat's gateway exits once idle is unknown; check with
  `ps`.
- **A Codex seat's own permission settings** were enforced natively in 0.7.3's test with Codex 0.164.0; other versions
  weren't tested.
- **Shared channels are Slack only,** and the primary user's authority in the TUI is attribution, not authentication.
- **The cmux path wasn't tried in a real cmux,** and a remote host's rigs are read over HTTP only.
- **Not in 0.7.4:** verified task viewers (#2133), switching a seat to an isolated account home (#2138, #2143), source
  evidence for resolving stuck findings (#2153), the stale-pane repair message (#2157), current launch evidence for
  fresh handovers (#2159), a warning for out-of-range MCP daemon ports (#2160), Hermes resume and measured idle exit,
  and OpenClaw interrupted-turn recovery. The gaps listed for 0.7.3 still apply unless a change above names them fixed.
