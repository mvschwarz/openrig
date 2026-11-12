# Choose a Herdr session for a terminal view

Use `--session <name>` to open a view in a named Herdr session on the daemon's
host. For example, keep development and production rigs in separate sessions:

```sh
rig terminal open future-rig --provider herdr --session default --json
rig terminal open future-prod-rig --provider herdr --session future-prod --json
rig terminal status --provider herdr --session future-prod --json
```

The explicit provider form places the view in the existing Herdr session
without opening a desktop window. Use Herdr's own session management to prepare
the session. An unavailable selected session returns `herdr_unavailable`; it
does not redirect the view to a different session.

The `session` field in an open result confirms the requested selection. Status
also names the session and returns its resolved control socket in `status.launch`.
Session names are a single non-empty name, such as `future-prod`, rather than a
socket path. `--session default` explicitly selects Herdr's default session.

## Default selection and scope

When Herdr is selected with no `--session`, the daemon uses the endpoint selected when it started:
its `HERDR_SOCKET_PATH`, then its `HERDR_SESSION`, then the default endpoint.
Setting either variable only on a later `rig terminal open` command does not
change that daemon configuration. Pass `--session` for a per-command selection.

With neither a provider nor a session, the daemon's open and preview APIs try
a live Herdr first, then a live cmux. An explicit session always selects Herdr
and skips that fallback, including when the daemon's default Herdr endpoint is down.

Session paths use the daemon's `XDG_CONFIG_HOME` when set, or `HOME/.config`
when unset. Relative paths (including an empty value) resolve from the daemon's
startup directory, matching Herdr's configuration selection. Named sessions live under
`herdr/sessions/<name>/herdr.sock`; `default` uses `herdr/herdr.sock` directly.
These settings are captured when the daemon starts.

If the requested name equals the daemon's `HERDR_SESSION`, it keeps that
session's explicit `HERDR_SOCKET_PATH`. A different requested name uses the
configuration-tree path, without reusing the override or inferring a session
from an arbitrary socket path. With an explicit socket but no configured
session name, omit `--session` to keep that exact endpoint. A missing selected
socket never falls back to another session. Viewer and follow operations carry
that exact socket to the CLI through `HERDR_SOCKET_PATH`, without an explicit
CLI `--session` that would override it. They check that the CLI reports the
selected socket before changing its panes. Daemon-side CLI calls retain the
startup environment; desktop follow uses the socket confirmed by the daemon.

The selection belongs to the request. Saved views still describe membership
and layout, so pass `--session` again when reopening the view in that session.

The existing view rules apply: saved views, rig and pod views, read-only mission
and slice views, pagination, absent seats and partial results all use the same
composer. Selecting a session changes where those tiles are placed. It does
not relaunch the seats' tmux sessions or move queue ownership.

## Open results

For Herdr, a successful layout request alone does not count its seats as opened.
OpenRig checks the returned tab's pane list. A missing tab identity or an
unreadable, empty or unattributable listing puts the affected seats in
`degraded`, with `code: "pane_unconfirmed"`, instead of `opened`. The CLI and
TUI name those seats as unconfirmed. Inspect the terminal before retrying:
the layout may have taken effect even though its panes could not be confirmed.
Confirmed seats on other pages still count; with none confirmed, the command
returns a nonzero exit status. Reusing an existing workspace keeps its separate
reuse result. This pane check does not prove desktop visibility or create a
verified viewer mapping.

## Replacing a seat's session

New tiles keep their place when a seat's tmux session is replaced. They wait up
to 30 seconds for the same session name and managed seat identity to return,
then show the new session with the original read-only setting. This uses the
shared tile command for Herdr, cmux, Rex and plain tmux, including SSH tiles.
In-place handover and restart keep showing the same session. The exception is
an SSH tile when the local tmux server is isolated: it runs
`rig terminal attach` on the seat's host (`--read-only` for a read-only tile),
which attaches with tmux once (`tmux attach -r` for a read-only tile). It
doesn't follow a replaced session or a restarted tmux server; reopen the view.

Writable tiles attach immediately, as in 0.7.10. Their visible terminal sizes
the agent's PTY under tmux's normal client sizing policy, and resizing the
terminal reflows new output. Read-only tiles remain observers: they neither
resize nor type into another seat. An ordinary tmux detach ends the writable
tile without stopping the agent. A replacement with a different managed seat
identity is not followed. If no replacement returns in time, or a
session has no managed identity, reopen the rig view with
`rig terminal open rig:<name> --window` (or your explicit provider). Views
opened before this change must be closed and reopened to get this behavior.

As in published 0.7.10, Enter or Ctrl-C typed while a new writable tile is still
attaching can close that viewer. The agent keeps running; reopen the view.
Once attached, keys and paste use native tmux input handling.

## Sizing and older views

Use tmux's inherited `window-size latest` policy for the terminal most recently
used to control sizing. OpenRig does not change a person's global tmux policy.
A deliberate `window-size manual` setting remains an explicit fixed-size choice.
OpenRig's temporary layout and readable-capture pins release by unsetting the
window's local `window-size` option; they do not restore an old local override.
With the last pin released, the window inherits the global policy again.

Browser terminals do not pin the agent's PTY by default. For an explicit fixed
90-by-27 browser terminal, use `rig config set terminal.fixed_geometry true`.
Set it to `false` to return to the default. This applies to newly created browser
brokers after existing browser subscribers disconnect; it does not configure
native Herdr tiles. A temporary readable capture uses
`rig capture <seat> --readable` or `--size <columns>x<rows>` and releases its pin
when the capture finishes. It does not unset a manually fixed window it did not
pin.

Kept writable 0.7.8/0.7.9 viewers can retain an old `ignore-size` attach, and
pre-reflow 0.7.11 viewers can retain the old mirrored display. Changing saved
argv cannot change that running client. Close only the owned Herdr viewer pane
and open a fresh view with `rig terminal open <view> --provider herdr`; the
agent's tmux session and conversation keep running. For a retained `--follow`
canvas, first select `--no-follow`, then close its owned viewer panes and open
a fresh ordinary view. Continuing that old following canvas is not an automatic
live-client migration. Existing 0.7.10 sizing clients and read-only viewers do
not need this step.

## Desktop windows and previews

```sh
rig terminal open future-prod-rig --session future-prod --window --json
```

The window launcher, readiness checks, workspace inventory, reuse and layout
application use the selected endpoint. When launched inside Herdr, the current
Herdr endpoint must match that selection to reuse the current terminal. To
place a view in another existing session from such a caller, use the explicit
`--provider herdr` form without `--window`.

An endpoint-mismatch error also gives a command for the caller's own session,
such as `rig terminal open future-rig --session work`. Previously it only
explained how to place the view in the daemon's selected session. The caller's
name comes from the same resolved socket path used by the endpoint check:
`~/.config/herdr/sessions/<name>/herdr.sock`, or `default` for
`~/.config/herdr/herdr.sock`. An explicit `HERDR_SOCKET_PATH` takes precedence
over `HERDR_SESSION` for both the check and the suggestion. Other custom socket
paths keep the existing guidance without guessing a session name, even when
`HERDR_SESSION` is set. Reporting the mismatch opens nothing.

Previews include the selected session in their fingerprint. A preview from one
session cannot authorize an open in another; refresh the preview after changing
the selection. The CLI asks the daemon to confirm named-session support before
requesting an open, so an older daemon cannot silently ignore the option and
write into its default session. An unconfirmed reply after an open is reported
as an unknown outcome; inspect the selected session before retrying.

`--session` applies to Herdr. A named session does not fall back to plain tmux
when Herdr is absent, and combining a session with cmux is rejected. Existing
workspaces are kept during reuse checks. Any suggested cleanup command for a
stale named-session workspace includes the selected socket.

## Rex

```sh
rig terminal open future-rig --provider rex --json
rig terminal open future-rig --window --json
rig terminal status --provider rex --json
```

`--provider rex` opens the view as a new session on the daemon's Rex server,
one window per page of the view, without switching any app to it. A tile whose
attach fails within ten seconds stays open showing the error, and the result
lists that seat as degraded when the failure shows up in the check made about
two seconds after opening. OpenRig picks
Rex only when it is named, or for `--window` (or no provider) when the command
runs inside a Rex block, including in a tmux started there. Everywhere else the
defaults above are unchanged, and the daemon's open and preview APIs never pick
Rex for a request that names no provider.

From inside Rex, the window form first checks that the daemon uses the same Rex
server as the calling terminal. When they differ, nothing is opened. After the
open it asks the Rex app showing the caller's session to switch to the new one,
choosing the app whose window holds the caller's terminal when several show it.
When no app can be chosen, or the app refuses the switch, the result names the
session to select by hand. A Rex app accepts the switch only with Remote Control
turned on in its Settings, under Rex Server.

Each local seat's tile shows the seat's runtime (such as Claude Code or Codex) and
its activity: working, idle, or blocked (with a permission kind for a permission
prompt). The tile gets the current activity once it opens and each change after
that, as `rig ps --nodes` resolves it. A Rex tile attached to the seat some other way, by
hand or by Rex after an app restart, is caught up within about ten seconds, or within
five minutes when no Rex tile was showing the seat before.
Rarely, a report can arrive in the middle of tmux's own output and garble part of a
Rex tile until it redraws. When OpenRig doesn't know a seat's activity,
the tile shows none rather than idle. OpenRig writes these reports only to the
tmux clients attached to the seat that identify themselves as Rex, so other
terminals attached to the seat get nothing and no tmux option changes.

The daemon finds `rex` in `$REX_BIN_DIR`, then on `PATH`, then inside the Rex
app on macOS, and uses its own `REX_SERVER` when set. It never starts a Rex
server. An open view is not reused: opening it again adds a numbered session,
such as `future-rig (2)`. `--session` applies to Herdr only. An unreachable Rex
server returns `rex_unavailable` and a failed session create returns
`rex_session_failed`, both as HTTP 200 results with `ok: false`. When Rex
doesn't confirm a session create or a page, for example because its reply
timed out, OpenRig closes nothing: the result says `rex_outcome_unknown`, or
adds a note when other pages opened, and names the session to check in Rex
before retrying. `rig terminal status` gives Rex about a second to answer.

## herdr-app

`--provider herdr-app` opens the view in the herdr-app window you run it in. Inside a herdr-app terminal, plain `rig terminal open <view>` does the same when that window is answering (finding the socket file is how OpenRig guesses you are in a herdr-app window, and whether the window is reachable is checked by asking it). `--window` always asks for a new desktop window. See [OpenRig views in herdr-app](herdr-app.md).

## HTTP API

- `POST /api/terminal/open`: `{ view, provider?: "herdr", session?: string, expectedPlan?: string }`.
- `GET /api/terminal/preview?view=<view>&provider=herdr&session=<name>`.
- `GET /api/terminal/status?provider=herdr&session=<name>`.
- The alias `POST /api/rigs/:rigId/terminal/open` accepts the same session and
  preview binding, with the rig determining the view.

Malformed names and unsupported provider/session combinations return HTTP 400
before socket calls. A changed preview returns HTTP 409. An unavailable Herdr
session keeps the normal HTTP 200 provider result with `ok: false`, its selected
`session`, an error code and direct-attach guidance.
The `kernel_seats_unavailable` result also keeps the selected session, so the CLI
reports that known failure instead of replacing it with an unconfirmed-session error.

## Task terminal views

`rig terminal open qitem:<id> --provider herdr --json` opens a derived, read-only
view of the current owners of a local queue episode. The episode includes the
requested row and explicitly linked descendants; only pending, in-progress and
blocked obligations contribute owners. It does not include historical senders,
closed predecessors, parent episodes or siblings. Membership is not input
permission.

The existing daemon endpoints accept the same view:

```text
GET /api/terminal/preview?view=qitem:<id>&provider=herdr
POST /api/terminal/open {"view":"qitem:<id>","provider":"herdr","expectedPlan":"<preview planId>"}
```

Preview and open include `task: {kind:"qitem", id, qitemId, name, complete, issues, members}`. Each member
names its structured `{hostId, nodeId}` key (null when unresolved), seat,
contributing `obligations`, `availability` and `viewerStatus`. Stopped, missing,
external and unresolved remote owners remain visible. Remote queues are not
crawled and no remote tmux socket is guessed. A bounded or damaged lineage is
explicitly incomplete; it is never silently presented as the whole team.

The local lineage read has work limits: 50,000 scanned rows (plus one overflow
sentinel), 8 MiB of encoded lineage, 100,000 links, and 16 KiB per chain record.
It reads one snapshot from the requested task forward, then probes earlier active
obligations using the queue's existing state index and follows references by exact
ID, including closed intermediaries. A child may arrive before its referenced root.
All these reads share the work limits; unrelated older closed history is not scanned.
Only the requested episode is expanded, up to 256 rows. Caller-supplied task IDs
are supported.
Hitting a work limit preserves known members and reports incomplete membership;
it does not claim that an owner outside the scanned history is absent.

Preview and open also include `viewDescriptor: {kind, name}`: `following` for
derived views and `fixed` for a saved layout. A task uses its row summary as
its name, falling back to the qitem ID. The existing preview `view` string is
unchanged. A following view derives membership when requested; it does not
mean an open workspace updates itself.

Preview is read-only. A member without owned viewer provenance is
`not-provisioned`; the ensure operation below can establish a reusable provider
mapping. An explicit open retains the provider's existing workspace behavior;
it does not continuously reconcile the view or change an agent's lifecycle.

## Following one task

`rig terminal open qitem:<id> --follow` keeps one workspace following the
task's current obligation owners. A joining member gets a verified local
viewer tile without taking focus. A departing member loses only its viewer,
after a grace period; the agent and its conversation keep running. The
explanation strip names joins, departures, unavailable terminals and limits.
The first workspace on an empty provider may become focused.

Live following supports **Linux and macOS with Herdr protocol 22**. Admission
checks the live protocol and selected socket, then confirms each pane's IDs,
focus state and foreground attachment. A shell startup `cd` does not change
pane identity; filesystem aliases of the same existing path are accepted.
If a creation response is lost and shell startup changes the directory, Core
may be unable to attribute that pane. It reports uncertainty and does not
repeat the creation.
The detected Herdr version remains visible in provider status. The native
qualification version is 0.9.5; a matching release label alone is not proof of
compatibility, and future protocol numbers are not assumed compatible.

If a new view's platform or protocol cannot support following, Core opens a
labelled **snapshot** instead and disables automatic following. It will not
track later owner changes. Incomplete membership prevents that snapshot from
opening; the result explains why. A failed endpoint/identity read or an existing
canvas stays unconfirmed, preserving it instead of creating a fallback view.
Other providers and selector kinds retain ordinary one-shot open. Use
`--provider herdr --json` to operate without opening a desktop window, and
`--session <name>` to select that endpoint. Typing in a tile can change the
agent's terminal size while you type.

```bash
rig terminal open qitem:example --follow --provider herdr --json
rig terminal open qitem:example --follow --provider herdr --pin reviewer@team
rig terminal open qitem:example --follow --provider herdr --max-tiles 12
rig terminal open qitem:example --follow --provider herdr --suppress reviewer@team --suppression-ms 60000
rig terminal open qitem:example --no-follow
```

`--unpin` and `--unsuppress` reverse those presentation choices. The default
cap is eight tiles; explicitly raising `--max-tiles` overrides it. Pins can
exceed the cap rather than being evicted. A departed tile retained for typed or
unconfirmed input does not consume a slot for joining members. Disabling removes
the saved following selector and keeps the existing layout intact.

The default departure grace is four seconds (`--grace-ms`). A focused leaver
gets another twelve seconds for reading (`--focus-retention-ms`); before its
tile closes, focus moves to a verified surviving member, or to the explanation
strip when none remains. Typed or unconfirmed input keeps the tile, labeled
as no longer participating. Explicit suppression also retains a typed draft.
Pi, terminal and community harness input may be unreadable to the composer
inspector: those tiles remain while input is unconfirmed, even after unpinning.
Each input-retained departure gets one delayed recheck after thirty seconds.
After that, queue or node/session lifecycle events, or an explicit repeat of
the follow command, can reconsider it. Activity hooks do not wake following,
and input is not repeatedly polled. Draft text is never saved.

Following consumes Core events and one-shot retention/suppression deadlines,
not repeated CLI membership queries. Complete empty membership drains the
tiles and preserves the workspace. Once no retained tiles remain, following
stops and the selector releases its active slot; new work does not automatically
restart it. Run `--follow` again to resume the same workspace. An incomplete source, failed provider read
or changed pane/terminal generation retains the previous view and reports
the uncertainty. It never authorizes a blind workspace rebuild or close.
`rig terminal views --json` and `rig terminal status --json` include the saved
active selectors and latest following status. Active selectors and owned viewer provenance
survive daemon restarts; task membership is always re-derived.

The owner-authorized HTTP operation is `POST /api/terminal/follow` with
`{view:"qitem:<id>",provider:"herdr",session?,enabled:true,maxTiles?,pin?,unpin?,
suppress?,unsuppress?,suppressionMs?,graceMs?,focusRetentionMs?,expectedPlan?}`.
Seat controls are arrays of names from the current/retained view. It uses the
existing terminal bearer boundary, like ensure-viewer. The response includes
the stable `workspaceId`, normal open partitions, `viewDescriptor`, and
`following:{id,enabled,state,maxTiles,tiles,events,overflow,nextAt?}`. Presentation
provenance grants no membership or input authority. This is a local native
viewer operation; browser input and remote-host provisioning are separate.

## Ensuring an owner viewer

The owner-facing HTTP operation `POST /api/terminal/viewer/ensure` accepts
`{view:"qitem:<id>", member:{hostId,nodeId}, provider:"herdr", session,
expectedPlan}`. Use a current preview's member key and plan. This explicit
operation uses the daemon's existing terminal bearer and browser boundary;
a bridge must retain its signed-in owner, Origin and expiry controls. It does
not grant authority based on task membership or accept a caller terminal ID.

On a supported Linux or macOS Herdr protocol-22 endpoint, it creates one viewer
or reuses an owned, verified `{workspaceId,paneId,terminalId,readOnly}` mapping.
A repeated/concurrent request does not create another viewer. Each viewer's
private `attach.sh` is kept for provider restarts. `--no-follow` preserves the
workspace and its scripts; stopping Herdr is not proof that its panes are gone.
Core removes only an exact, unedited owned script after confirming its viewer
is absent. Old views that are never reconciled again can therefore accumulate
scripts; there is no cleanup based only on an unreachable provider.

A lost create reply is reconciled before starting anything else; a lost run
reply is checked against the actual foreground process, never blindly repeated. Unknown or
changed terminal identity remains unconfirmed. The operation does not relayout,
close departed viewers, take over control, focus existing panes or launch/stop
agents. A first workspace on an otherwise empty Herdr server may become focused.

Preview remains passive and names `not-provisioned`, `verified` or `unconfirmed`
viewer status. Studio can ensure a new member, add its browser frame, and retain
a pinned leaver labeled as no longer participating. The provider mapping is
small presentation provenance, separate from queue membership. Herdr display
labels are not that provenance. Other providers/platforms remain unsupported
for ensure-viewer until qualified; ordinary open retains its existing behavior.

A tmux window has one size, and a tmux client narrower than it sees only the
left part of each line. So a read-only tile shows its seat without attaching to
it: about once a second it reads the seat's screen with `tmux capture-pane`,
redraws only after tmux records new activity, and lets the tile's own terminal
wrap each line. A read-only tile narrower than the agent's window still shows
whole lines, and showing a seat never changes its size. A rule drawn across the
window is cut to the tile's width. A read-only tile has no scrollback of its
own. (A read-only SSH tile on an isolated local server attaches read-only
instead; see [Replacing a seat's session](#replacing-a-seats-session).) A
writable tile attaches with plain tmux when it opens (see
[Replacing a seat's session](#replacing-a-seats-session)): keys and paste go
through tmux as in any attached client, tmux's prefix works (prefix then `[` to
scroll back, for example), and the tile sizes the window while it's the active
client. If the seat's tmux server restarts, a tile shows the seat again only
when the same managed seat returns. The printed manual attach commands are
`tmux attach -t` for a writable tile and `tmux attach -r -t` for a read-only
one, with a local seat's tmux server (`-L <name>` or `-S <path>`) when it
isn't tmux's default socket. For a seat on another host they run over `ssh -t`, and
when the local tmux server is isolated, as `rig terminal attach` on that host.
Observers of a Herdr terminal do not themselves resize
it; a controlling browser can. No cross-version resize guarantee is implied.

To type into a seat without changing its size, send the text through OpenRig
(`rig send`, or `POST /api/transport/send`): it is written to the pane with tmux
buffers and keys, and no client attaches. There is no supported way to attach a
writable client that is sure never to resize the agent's window.


## Following a slice or mission's current work

Use `rig terminal open slice:<name-or-id> --follow --provider herdr` to keep
one workspace following the current destination owners of that slice's active
queue rows. `pending`, `in-progress` and `blocked` rows count. A member can own
several rows; `task.members[].obligations` preserves every row and state.

A slice resolves within the daemon's configured slice index, by exact directory
name or unique frontmatter `id`. Tags must name it exactly: `rig queue create
--slice <name-or-id> ...` associates a row. Handoff inherits those tags unless
replaced; merely linking an untagged child does not associate it. A mission-only
tag does not put a row in every slice. No project is inferred from a tag or the
caller's working directory. A bare name or ID claimed by multiple slices is
`scope_ambiguous`; no first-match scope is selected. Selecting a unique key can
still follow a slice whose other alias is reused: a row carrying that colliding
alias must have exactly one `mission:` tag naming exactly one indexed claimant.
Rows placed in another mission are excluded. Missing, contradictory or otherwise
unplaceable mission/alias tags make the snapshot incomplete, retaining previous
viewers. A unique alias on its own retains exact matching. Flat legacy slices
without an indexed parent mission cannot disambiguate a colliding alias.

Mission views use `mission:<directory-id>`, from the same configured index.
A mission is known when its directory contains `slices/` (even empty) or a
readable `mission.yaml` declaration. Its directory ID is its exact identity;
mission frontmatter is not an alias. Membership is the union of active rows
with that exact `mission:` tag and rows associated with any physically indexed
child slice by its exact name or unique ID. Each row counts once even when it
has both tags. Flat legacy slices without that parent association are not
inferred into a mission. A child's historical status or composition activation
flag does not remove its current obligations from the union. Duplicate mission
IDs are ambiguous. Shared child names/IDs are omitted from bare slice matching;
rows with one indexed claimant mission are placed through their mission tag.
A direct mission tag takes precedence, including work tagged to both missions.
Without that direct tag, a shared-key row with missing, contradictory or
non-claimant mission tags is named in `issues` and makes the snapshot incomplete;
known owners remain.
The launcher reads this same terminal preview and submits its `expectedPlan`
when opening, rather than using the review-agent roster.

Slice and mission keys are case-sensitive and can include Unicode, plus signs and internal
spaces. They cannot be empty or contain slash, backslash, control characters,
or leading/trailing whitespace in the scope reader. The service trims the whole
selector before composition, so a trailing selector space is accepted by
preview/ensure with the same plan; ensure rejects a leading selector space.
Prefer the exact canonical selector in every call. Pass it in JSON or a quoted
CLI argument; encode it once as a GET query value. Do not double-decode it.

Slice previews and open results use `task: {kind:"slice", id, name, complete,
issues, members}`. `id` is the unique frontmatter id, or the directory name when
no id is present. There is no synthetic `qitemId`. Preserve the preview's `view`
for the ensure request. All successful previews, including qitem previews,
include `capabilities: {ensureViewer:boolean}`. True means that the resolved
view/provider implements ensure; the existing member, completeness, owner and
`expectedPlan` checks still apply. A missing capability/task on an older daemon
is unsupported scoped membership, not an empty team.

Mission results use the same shape with `task.kind:"mission"`; `task.id` and
`task.name` are the directory ID, with no synthetic `qitemId`. Ordinary mission
preview/open uses this current-obligation membership too: past participants
without active obligations are excluded, while unavailable current owners
remain named. Follow, preview and ensure share the same authority.

New slice and mission workspaces default to four automatic tiles; `--max-tiles` overrides
that. Qitem views retain their eight-tile default. The full membership and
obligation list remains available when tiles exceed capacity. Pins, drafts,
unknown input and focus retention still protect departed viewers. Closing a
viewer never stops its agent. Opening a tile can change the agent's dimensions.

A known empty slice or mission remains enabled in the same workspace; later associated
work can join it. An incomplete queue read (`task.complete:false` plus `issues`)
retains previous viewers. A missing scope is `scope_not_found`, duplicate scope
identity is `scope_ambiguous`, unreadable/capped index data is `scope_unavailable`,
and an unavailable resolver is `scope_unsupported`. None is authoritative empty.
Ensure of an incomplete snapshot returns `viewer_unconfirmed`; changed plans
return `preview_changed` before provisioning.

Ordinary ownership changes follow queue/session/node events. Node and directory
changes under the primary configured index use the existing filesystem watcher,
with a coalesced scope invalidation event. There is no repeating membership
poll. Structural edits under additional legacy roots, or a filesystem where
watching is unavailable, require `rig`'s existing slice refresh endpoint
`POST /api/slices/refresh` or reopening the view. Missing or unreadable sources
keep prior viewers; they never certify that the work disappeared.


Scope identity reads are bounded to 4,096 directory entries, 16 KiB per selected
node-header read, and 8 MiB of source bytes per index generation. The byte budget
counts the bounded read, including text after short frontmatter. An index that
exceeds these limits is too large for this read; use a smaller configured index
or a qitem view. This is separate from unreadable or malformed sources.
Queue membership reads are bounded to 50,000 active rows plus one lookahead,
16 KiB of encoded tags per row and 8 MiB of aggregate encoded tags. They remain
fresh on each render. Identities are reused within a scope-source generation
only while the primary-root watcher is live and existing additional roots are
covered by that root. A source event or explicit refresh invalidates them;
errors discard the cache. Unavailable watching or an existing unwatched legacy
root uses fresh bounded identity reads instead. Missing legacy roots are checked
on each call so an appearing root cannot reuse an older cached identity set.

Error bodies remain authoritative. `scope_unsupported` is HTTP 400,
`scope_not_found` is 404, and `scope_ambiguous`/`scope_unavailable` are 409.
An incomplete queue snapshot is a successful preview with `task.complete:false`;
ensure returns `viewer_unconfirmed` without a provider effect. Unsupported
ensure view kinds now return `view_required` (400), where they previously returned
200 with an error body. Unsupported follow view kinds
retain `follow_view_required` in a 200 `ok:false` body, as before. A changed
preview remains `preview_changed` (409). During automatic refresh a missing or
ambiguous scope retains the existing tiles and names the source problem in the
explanation strip; refresh or reopen it under the current unambiguous key.


## Reading or sending to an expected native conversation

An application that selects an original Claude Code or Codex conversation can opt
into an expected-identity check. The identity is the exact tuple `nodeId`, canonical
`sessionName`, `runtime` (`claude-code` or `codex`) and native `nativeId`. A registry
resume token by itself is not a current-process identity observation.

Read `GET /api/sessions/:sessionName/generation-record-expected` with query fields
`expectedNodeId`, `expectedRuntime`, `expectedNativeId` and optional `sinceBytes`.
It resolves the verified current occupant and native process, opens that native
record, checks its identity, and returns identity and bounded suffix bytes from
the same opened file. Its existing byte cursor and `generationId` semantics match
`generation-record`. Success adds `identityContract:1` and `checkedIdentity`, the
exact expected tuple. Check both before displaying the suffix as that conversation.

Send `POST /api/transport/send-expected` with the ordinary send body and a required
`expectedIdentity` object containing those four fields. The check runs again after
buffer preparation immediately before paste, and before Enter after any wait.
A retained input stores the constraint in its outbox receipt; committed dispatch
and reuse of its delivery ID cannot select a different original conversation or
omit the stored constraint. Delivery IDs still do not deduplicate explicit input.
Success adds `identityContract:1` and `checkedIdentity`. Retained is not sent;
`checkedIdentity` is an observation at an input boundary, not model consumption.
If replacement is observed after paste, the result reports `inputPhase:"written"`
and `sent:true`, with Enter refused. Inspect that input before deciding what to do.

Malformed expectations return 400 (`invalid_expected_identity`). A different
observed identity returns 409 (`expected_identity_mismatch`); a missing or
unverified identity returns 409 (`expected_identity_unavailable`). Conflicting
reuse of a delivery ID returns 409 (`delivery_identity_conflict`). No conditional
operation falls back to the replacement. Use these dedicated paths when detecting
support: older daemons return 404 instead of silently ignoring an unknown field.
Ordinary reads and sends without an expectation or an ID bound by an earlier
conditional send keep their existing behavior. Reusing a bound ID also carries
its stored constraint when the caller omits the expectation.

While a runtime switch is preparing or confirmed, a conditional send returns
409 `expected_identity_unavailable` with `sent:false` and `inputPhase:"not_reached"`.
It retains neither the input nor the expectation. Retry the conditional endpoint
with the original `expectedIdentity`; an ordinary send is not an identity-bound
retry unless its ID already has a stored constraint. Ordinary sends during the
switch keep their existing retained response.

This is a finite process/record observation followed by a terminal write; tmux has
no atomic native-conversation compare-and-write operation. A native conversation
change after the final observation remains a race. The check does not turn a
terminal attachment into a conversation pin: existing terminal viewers follow
managed pane/session bindings and may display their replacement. Applications
must keep that attachment limit separate from checked record reads and sends.
