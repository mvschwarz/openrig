# Create your own Slack app for OpenRig (experimental)

> **Experimental in 0.6.0.** The manifest (`rig slack manifest`) and this setup guide are new
> and have not been confirmed against a real app creation. The Slack connector itself and its
> `setup`, `verify`, `enable`, `disable` and `status` commands are not experimental. If a step
> here does not match what Slack shows you, please
> [open an issue](https://github.com/mvschwarz/openrig/issues/new/choose) or send a pull request
> ([CONTRIBUTING.md](../../CONTRIBUTING.md)).

OpenRig's Slack connector talks to a Slack app that you create in your own workspace. OpenRig
ships the app's manifest; it does not host an app, run an install endpoint, or publish anything
to the Slack Marketplace. The app is a Socket Mode app, so it lives in the one workspace you
create it in.

`rig slack manifest` prints the manifest. It works offline, before any daemon or token exists:

```bash
rig slack manifest          # the manifest as YAML
rig slack manifest --url    # Slack's create-app link with the manifest prefilled
rig slack manifest --json   # the manifest, its scopes and events, and why each scope is requested
```

The TUI shows the same link on the Connections page while Slack is not configured. Neither the
CLI nor the TUI opens a browser, accepts tokens, or creates an app.

## Steps

These are the expected steps, based on Slack's app-manifest documentation. They have not yet
been confirmed against a real creation run. Slack's form may ask for something the prefill did
not fill in; if so, follow the form.

1. Open the link from `rig slack manifest --url` in a browser.
   > **Note on Slack's manifest dialog:** If opening the link results in an empty manifest `{}`
   > or Slack reports an error translating the manifest, copy the output of `rig slack manifest`
   > (run without flags) and paste it directly into the **YAML** tab in Slack's "Create an app from
   > an app manifest" dialog.
2. Sign in to Slack if asked, pick the workspace, review the prefilled manifest, and click
   **Next**, then **Create**. (If **Create** stays disabled, go **Back** and check that a
   development workspace is selected and the manifest step shows no error).
3. Under **Socket Mode**, confirm it is enabled. Enable it if it is not.
4. Under **Basic Information → App-Level Tokens**, generate a token with the
   `connections:write` scope and copy it (it starts with `xapp-`).
5. Install the app to the workspace and approve the requested scopes.
6. Under **OAuth & Permissions**, copy the **Bot User OAuth Token** (it starts with `xoxb-`).
7. Put both tokens in a private env file readable only by you (`chmod 600`):

   ```bash
   SLACK_BOT_TOKEN=xoxb-...
   SLACK_APP_TOKEN=xapp-...
   ```

8. Invite the bot to the channel you will use (`/invite @OpenRig` in that channel).
   `rig slack verify` reports NOT ready until the app is a member.
9. Register yourself as the human the connector delivers to, with a Slack binding that names
   your Slack user ID (`rig gateway human add`; its `--help` shows the binding format).
   Messages from Slack users who are not registered are not delivered. `rig slack enable`
   needs a readable human registry: on a fresh install with no registry, or with an invalid
   one, it is refused.
10. Run `rig slack setup --channel <channel-id> --secrets-env-file <path>`, then
    `rig slack verify`, then `rig slack enable`.

## What the app asks for

Run `rig slack manifest --json` for the exact list and the reason for each scope. There are two
groups:

- **Baseline scopes**: posting messages, reading message history in public channels the app is
  a member of, and reading channel details.
  `rig slack verify` checks these.
- **Feature scopes**: `files:read` (download attachments people send), `files:write` (upload
  attachments to Slack), `app_mentions:read` (receive @-mentions of the app), `reactions:read`
  (receive emoji reactions), and `users:read` (identify a named bot, below). `rig slack verify` warns
  when one of these is missing (if Slack returns the granted scopes) but does not require them, so a
  READY from verify does not prove attachments, mentions, reactions or named bots will work.

If a feature scope was not granted, the effect differs by feature:

- **Attachments** (`files:read`, `files:write`): the file download or upload call fails. A
  message with an attachment that could not be downloaded is still delivered, with the failed
  file named in it. A post whose attachment could not be uploaded still delivers its text, and
  the failure appears only in the daemon log (`rig daemon logs`).
- **Mentions** (`app_mentions:read`): Slack does not deliver `app_mention` events to the app.
  Only `rig slack verify` warns that the scope is missing; nothing reports the missing events.
- **Reactions** (`reactions:read`): Slack does not deliver `reaction_added` events, so a reaction
  on an ask doesn't reach the asking agent. A reply in the ask's thread still does.
- **Named bots** (`users:read`): Slack refuses the bot lookup, so a named bot's posts are not
  delivered, and the daemon log names the refusal. Nothing else changes.

So after installing, compare the granted scopes Slack shows for the app with all eight scopes that
`rig slack manifest --json` lists.

The app subscribes to messages in public channels it is a member of (`message.channels`), to
mentions of the app (`app_mention`), and to emoji reactions (`reaction_added`). It does not request
direct-message or private-channel access.

A reaction added to an ask reaches the agent that asked, as a note naming who reacted and with
which emoji; the agent decides what it means. Every message OpenRig posted for the ask counts:
its first message, a long ask's numbered parts, and an ask posted as a reply in a thread. A
reaction on any other message, including a person's reply in the thread, is ignored. An app created from an older manifest has neither the `reactions:read` scope nor the
`reaction_added` event: add both under **OAuth & Permissions** and **Event Subscriptions**, then
reinstall the app to the workspace.

The manifest also turns on **Interactivity**, so the human can answer a decision's structured
questions by clicking a button (`rig queue create --human-questions-file`). In Socket Mode the
clicks arrive over the same socket, so no request URL is needed. An app created from an older
manifest has Interactivity off: turn it on under **Interactivity & Shortcuts**, or the buttons
will do nothing. A typed reply in the thread still answers the decision either way.
Each click gets one short reply in the decision's thread: what was recorded, or, when OpenRig
refuses the click or can't record it, why and what to do instead (the sender isn't registered, the
decision is no longer waiting for answers or was sent to someone else, the button no longer
matches its questions, or the message can't be matched to a decision). Slack's redelivery of a
click OpenRig already handled gets no second reply. The reply is best effort: while Slack is
rate-limiting OpenRig's posts it may not be posted, and the click is handled the same either way.

In the decision's `humanAnswers`, clicked answers remain option-id strings. A whole typed reply
is stored as `{kind: "typed-reply", text: "…", placement: "first-unanswered", unansweredCount: N}`
under the first unanswered question. That placement is automatic; it does not mean the person
selected that question. `N` counts the other question slots still empty in `humanAnswers` after
that placement. Earlier button answers are preserved; no other questions are filled in.
Read `text` as the person's words,
even when it equals an option id. The reply still closes the decision, so `done` is not approval.
A file-only reply closes the decision without recording a typed answer. If all button answers were
already recorded, they stay final and the typed reply remains in the correlated reply row.

## What the connector does with the tokens

The tokens stay in the env file you created. The connector reads them from that file and uses them
to authenticate to Slack: it opens an outbound Socket Mode connection with the app-level token and
calls Slack's Web API with the bot token. This connector has no OpenRig-hosted component and
makes outbound connections only. That statement is about this Slack connector, not about every
part of OpenRig.

## Next

- `rig slack status` shows what is still missing, without contacting Slack.
- `rig slack verify` checks the granted baseline scopes and channel membership with Slack.

## One channel per rig or seat (optional)

An ask to a person posts to Slack only when it's marked alert-worthy (`rig queue create --alert`); otherwise it waits on
Steering. By default every post goes to the one channel from `rig slack setup --channel`.
To follow each rig separately, post a rig's items, or a single seat's, to its own channel:

```bash
rig slack channel-map set my-rig C0EXAMPLE1
rig slack channel-map set pr@my-rig C0EXAMPLE2
rig slack channel-map list
rig slack channel-map remove pr@my-rig
```

- **Which channel an item posts to.** The item's seat is matched exactly first (`pr@my-rig`),
  then its rig (`my-rig`). Anything unmapped posts to the default channel, so a config
  without a map behaves exactly as before. Aggregate delivery digests have no single seat and
  always post to the default channel.
- **Threads.** Updates, `--reply-to` and later notifications for an item stay in its thread.
  With a map configured, if a seat's channel has changed since the thread was opened, the
  next post opens a new thread in the seat's current channel, and `--reply-to` records the
  fallback as `root-other-channel`. With no map, threads behave exactly as before: an item's
  next notification reuses its open thread in whatever channel that thread was posted in.
- **Changing the map.** A change applies to new posts. A post already in flight (one being
  retried after a failure or an unconfirmed send) finishes in the channel and thread it started
  in, and its retry checks that channel first so it is not posted twice. This includes adding
  the first map: a post first tried before any map existed finishes in the default channel.
  Without a map, OpenRig records nothing about a post's channel, so if the default channel
  changes while a post is being retried, the retry goes to the new default channel (as it always
  has); that also applies to a post first tried before the map was added.
- **Rate limits on posts.** When Slack rate-limits a post and asks for a pause of 10 seconds or
  less, OpenRig waits that long and retries the post once. A longer pause, or a second refusal,
  is left to the retry of retained posts.
- **Replies and new messages.** A reply in an item's thread reaches that item's seat, in any
  channel. To answer it in the same thread, the seat sends `rig queue create --human-intent update
  --summary "<subject>" --reply-to <the inbound reply's row>`.
  - **A new message a person starts in a rig's channel** goes to that rig's representative, the
    seat the rest of its rig reports to (its one `delegates_to` root). To send it to another seat,
    name it: `rig slack channel-map set my-rig C0EXAMPLE1 --inbound lead@my-rig`. A rig entry on the
    connector's default channel only sends that rig's posts there: new messages in the default
    channel still go to the inbound destination, unless the entry names `--inbound`.
  - **Every other new message,** in the default channel or a seat's channel, goes to the
    connector's inbound destination, as does a reply in a thread OpenRig doesn't know, or a rig's
    channel whose representative can't be found.
  - **Answers come back to where the person asked.** A person's new message is the root of its
    answer: when the seat it reached replies with `--reply-to` that message's row, the answer and
    later updates land in the person's thread, in the channel they used.
  - Missed-message recovery (below) covers the default channel only.

Invite the app to every mapped channel (`/invite @OpenRig`). `rig slack verify` checks
membership in the default channel and every mapped channel, and reports NOT ready until the
app is in all of them. A saved change reaches a running connector when it next rewires, which a
daemon restart does (`rig daemon stop`, then `rig daemon start`). `rig slack disable --reason
"<why>"` then `rig slack enable` rewires too, but alerts still waiting to be posted when it's
re-enabled are treated as already seen and aren't posted. Only an earlier post that failed or
didn't finish still posts: an alert whose row is still open, a decision-resolved notice, or a digest. The TUI's Connections page says whether the running
configuration matches the file.

The map is stored as `channelMap` in `slack-connector.json`, as a list of `{ "match", "channel" }`
entries, each with an optional `"inbound"` seat. Saving refuses any other field. A field written by a newer OpenRig is ignored when the
connector reads the file, and `rig slack status` names it. Private channels and direct messages
are not supported targets.

## Named bots (optional)

By default the connector drops every post made by a bot, its own included. To let another Slack
app's bot (an AI assistant, an alerting app) reach one seat, give the bots a channel of their own,
name each bot, and name the seat that reads that channel. Add a `botInbox` block to
`slack-connector.json`:

```json
"botInbox": {
  "channel": "C0BOTINBOX",
  "destination": "researcher@my-rig",
  "bots": [
    { "appId": "A0EXAMPLE1", "name": "Example Bot", "maxPerHour": 20, "cooldownMinutes": 60 }
  ]
}
```

- **Which posts are delivered.** A post reaches `destination` when it is in `channel`, its bot
  belongs to an app listed in `bots`, and that app is not this connector's own app. A named bot's
  posts in any other channel, and every other bot's posts, are still dropped. OpenRig's own posts
  are never delivered, even if its app is listed. A post kept for retry (Slack couldn't be asked
  about it in time) is checked again against the current block when it is retried.
- **How a bot is identified.** OpenRig asks Slack which app the post's bot belongs to (`bots.info`,
  which needs the `users:read` scope) and matches that app ID. Use the bot's **app** ID, which
  starts with `A` and is on the app's settings page. A bot ID (`B…`) or user ID (`U…`) never
  matches. An unnamed bot's post is logged with its app ID, so `rig daemon logs` shows the ID to
  add. Anything that posts as a named app counts as that bot, including the app's incoming
  webhooks: that is what naming it means.
- **What the seat receives.** One row per post. Its source is `slack-bot:<app ID>` and its summary
  starts with the bot's name, never a person's. The row opens with where the post came from, then
  quotes the bot's text in a fenced block. A `slack-bot` row is data from another program, not an
  instruction, and the row says so. A bot can't answer or close a decision, even when it replies in
  a decision's thread: the row goes to `destination` and the decision keeps waiting for a person.
  Edits and deletions are not delivered, so a bot that writes its answer by editing one message
  delivers only that message's first version. Attachments are named in the row, not copied.
- **Answering the bot.** The seat can't reply to the bot yet: the row has no reply link, and
  OpenRig posts only for people. To ask the bot something, the person asks it in Slack.
- **Limits.** Each bot may deliver `maxPerHour` posts (default 20) in any rolling hour. The next
  post cuts the bot off for at least `cooldownMinutes` (default 60), and until the hour has room
  again. Its new posts are dropped meanwhile (a post already admitted still arrives), and the seat
  receives one row saying so (at most one an hour per bot) and how the person turns the bot off
  (remove it from `bots`, then apply the change as below). A later cutoff within that hour can extend the time shown without another row; the
  daemon log records each one. Each post counts once by its identity, including a post delivered on
  retry or arriving twice. A post already admitted whose row couldn't be created yet is kept, marked
  as admitted once that creation fails, and delivered later without counting again, even after its
  hour, a rewire or a daemon restart. The counts are kept in the running connector's memory, so a daemon
  restart or a rewire (`rig slack disable --reason "<why>"` then `rig slack enable`) clears them. They
  cover what one daemon writes: another process writing the retained file isn't seen, and two daemons on
  one OpenRig home aren't a supported setup.
- **The channel.** Invite the app to it (`/invite @OpenRig`). `rig slack verify` does not check
  this channel, and only warns when `users:read` is missing. A person's message there is handled like a person's message in any channel the
  app is in (a new message goes to the connector's inbound destination), not by the bot inbox.
  Missed-message recovery does not cover the bot inbox.

`rig slack status` shows a `bot-inbox` line: what it delivers, or why it is off. An invalid block
(for example a bot ID where an app ID belongs) turns only the bot inbox off. A saved change
reaches a running connector when it next rewires, which a daemon restart does (`rig daemon stop`,
then `rig daemon start`). `rig slack disable --reason "<why>"` then `rig slack enable` rewires too,
but alerts still waiting to be posted when it's re-enabled are treated as already seen and aren't
posted. Only an earlier post that failed or didn't finish still posts: an alert whose row is still
open, a decision-resolved notice, or a digest.

## One app across machines (optional)

Slack delivers each event of an app to one of its connections, so one app can serve several
OpenRig machines only if one machine, the hub, holds the connection and relays each other machine's
channels to it. Each machine still decides who its messages reach, keeps its own threads and
decisions, and posts its own replies.

- **On the hub:** the bot token and the app-level token, as usual, plus `forwardChannels` in
  `slack-connector.json`, one entry per channel another machine owns:

  ```json
  "forwardChannels": [
    { "channel": "C0EXAMPLE3", "host": "vps04" },
    { "channel": "C0EXAMPLE4", "host": "vps04" }
  ]
  ```

  `host` is that machine's id in the hub's host registry (`rig host list`). It needs an http
  entry, which `rig host pair` writes with that machine's token; the hub sends it with each relay,
  and the machine checks it when it has `OPENRIG_AUTH_BEARER_TOKEN` set.
- **What the receiving machine trusts:** a relayed event comes from whoever holds that machine's
  daemon token (or, with no token set, anything that can reach its daemon), not from Slack directly, and nothing checks Slack's own signature on it. The
  credential issued by `rig host pair` is the daemon API bearer, not a relay-only credential; it also authorizes the other daemon write APIs that use that bearer. The
  machine still looks up the sender in its own list of people, but on a relayed event that's no
  proof a person just typed or clicked it in Slack: it trusts the caller for where the event came
  from.
- **On every other machine:** the same app's bot token only, with no app-level token, so it opens
  no connection of its own. Set its default `channel` to its own channel and, for a rig's channel,
  a channel map entry. Its connector is enabled as usual. Its `rig slack status` reports
  `relayedInbound`: that it can take relayed events, and how many have arrived since it started.
  It also retries its own kept events every five minutes, including any it kept before it stopped
  holding a connection of its own, so those still land.
- **What happens to a message:** the hub relays the event, a reaction or a button click untouched
  to the machine that owns the channel. That machine handles it exactly as if it had received it:
  who may send, where it goes, its thread and its decisions. If the relay fails (the machine is
  down or its registry entry is wrong), the hub keeps it and retries every five minutes, after its
  own kept events and clicks; `rig slack status` counts it in the dead-letter backlog. A machine
  that's down costs one attempt per retry: its other relays wait for the next one. A relay the
  machine keeps refusing is kept and retried with no limit, because dropping it would lose a
  person's message.
- **Changing forwarding entries is not a drain or cancellation:** relays already retained keep
  their original host and remain visible in `rig slack status`, even after the last entry is
  removed. An enabled connector retries them; disabling it pauses retry without deleting them.
  Let relays finish before removing a forward entry. A zero dead-letter backlog alone does not
  prove they have drained: it does not count relay HTTP requests still in flight.
- **Who answered:** every post ends `from <seat> on <machine>`, using the machine's host id (set
  it with `host.name`).
- **The hub's own channels** are handled on the hub, as before. A channel can be relayed to one
  machine only, and never the hub's own default channel.
  Messages that match neither forwarding nor an existing thread or channel route fall back locally
  to `inboundDestination`; `rig slack status` names that policy and destination. These lists do not
  establish exclusive channel ownership: two machines can still both handle a channel.
- **Missed messages:** each machine recovers the channels it owns: the hub its own channels, and
  every other machine its default channel and its channel map's (the hub never recovers a channel
  it relays). See [Reconnect recovery and status](#reconnect-recovery-and-status).
- **Not covered yet:** `rig slack verify` on the hub doesn't check the app's membership in relayed
  channels.

## Quiet hours for a person (optional)

Quiet hours hold a person's routine asks while they're on, and post them once they end.

- **Set them** with `rig gateway human quiet set <entityId> --daily 22:00-07:00` (every day) or `--until 07:00` (from now
  until then), with `--tz` for the person's zone. `show` reports whether they're on, `end` ends tonight's early ("I'm back";
  a daily rule stays for tomorrow), and `clear` removes the rule. A person's mode can set them too (`rig gateway human
  mode save … --quiet`).
- **While quiet is on,** an ask that would post to the person isn't posted and doesn't mention them, whatever their delivery
  class: it's held, and its row records the hold.
- **Not held:** an urgent ask, meaning one tagged `escalation` or `wake-escalation` that isn't an update, and the operator's
  wake-ladder alerts. These reach the person exactly as they would outside quiet. An ask below the posting level is only
  logged, as at any time.
- **When quiet ends,** each held ask that never started posts once, on its own, with no mention. One that no longer applies
  isn't posted, and its row says why: it closed, a newer notification replaced it, its recipient changed, or it's now below
  the posting level.
- **A post that may already be in Slack**, confirmed or only partly sent, isn't held: it finishes as itself, in its own
  thread.
- **If quiet hours can't be read,** nothing is posted to that person until they can.

## Reconnect recovery and status

The daemon scans available top-level messages and replies broadcast with **Also send to
channel** in the channels this machine owns: its default channel and its channel map's, except a
channel it relays to another machine. It also scans replies in the threads it tracks in those
channels whose root was posted, or which closed, within the last seven days. A root's age is its
Slack posting time, so rebuilding the thread map doesn't make an old thread eligible again. An old
thread that closed within seven days is scanned from its root, so this isn't a seven-day history
limit. Missed replies in older open threads aren't caught up; live delivery is unchanged.

The hub scans after a Socket Mode connection and on its existing five-minute retry cadence. A
machine the hub relays to scans every five minutes, and recovers only the channels it owns that the
hub has relayed it an event for. Each such channel's coverage starts when its first relayed event
arrives, and is kept across restarts, so a restart needs no new event. A channel the machine no
longer owns isn't scanned, and a machine nothing is relayed to never reads its channels' history.

Broadcast replies keep their thread's routing. Recovered tasks say **Recovered after a gap** and
show the original Slack posting time. A recovered thread reply lands as a reply in its thread,
marked late, and never answers a decision, even one still open: the seat reads it and decides. A
recovered broadcast reply does the same in every channel except the default channel of the machine
that holds the Socket Mode connection, where it behaves as before; a relayed machine's default
channel counts as newly covered. A dead-lettered recovered reply keeps that mark when it's retried.
They use the same sender admission, routing, attachment handling, fixed identity
and dead-letter path as live messages. A durable dead letter is custody of a
failed delivery, not successful delivery.

Recovery keeps a per-channel checkpoint across reconnects, restarts and channel
switches. For the hub's default channel it initializes once from the newest retained accepted
channel landing; without such evidence it starts at feature adoption. Every other channel starts
when recovery first adopts it. **Older history is unknown.** A tracked thread's checkpoint starts
at its root, so its first scan reads the whole thread; replies that already landed are recognized
and not delivered twice. New live messages never move the recovery checkpoint. A
partial scan resumes its saved interval; only an exhausted interval advances the
covered boundary. The checkpoint moves past a message once it landed, was a duplicate, was
dead-lettered, was refused because its sender isn't admitted, or was skipped as a kind inbound
doesn't take (a bot's post, an edit or join, an empty message). Each new interval ends five seconds before the local clock to
allow recent messages to become visible; larger clock skew or visibility lag is
not covered by that margin. A corrupt or unreadable checkpoint leaves recovery unavailable
and preserves the existing file; live inbound continues.

Each pass admits at most four history calls, 100 entries and 15 seconds of work, with a
five-second request ceiling. Channels and threads take turns within that one budget, so with many
tracked threads each thread is scanned every few passes; `rig slack status` shows how far behind
the oldest waiting thread is. Work already started on a message, such as
an attachment transfer, is not cancelled by these limits or by a stop, and a new
pass waits for it to finish. Rate limits retain Slack's Retry-After across restart, and hold back
only the method Slack limited (channel history or thread replies).
Transport and server failures use a five-second backoff unless Slack supplies Retry-After.
When Slack reports a plan history limit, recovery still lands the available page
and advances normally, retaining an older-history limitation in status across restarts.
Missing bot credentials, history scope, membership, retention limits and API
failures appear as recovery limitations. A tracked thread Slack can't find stays incomplete in
status, with no further call, until its thread mapping changes or the daemon restarts or rewires
the connector; that isn't proof the thread was deleted. No additional scope is required to keep
live delivery working. Threads nobody tracks, older open threads, threads closed more than seven
days ago and other channels remain outside this recovery scope; global chronological order is
not promised. This change does not replay intervals already checkpointed before broadcast-reply
recovery was added.

`rig slack status` retains local configuration checks and adds a bounded daemon
snapshot: socket state/generation, last event, recovery interval/state/reason for each
channel, a thread line (tracked, scanned, waiting and why any are backing off or incomplete),
retry time and accepted/dead-lettered recovery counts since the connector last
started, including threads that have since left the window (they reset when it is enabled or disabled, and when the daemon restarts).
It also reports the durable dead-letter backlog: the retained records for inbound messages,
reactions and click answers that await retry, including retained relays, counted across all three
dead-letter files so the number survives a restart. Retry is paused while the connector is disabled.
If a file cannot be read, status shows unknown with a reason and no count.
Human-readable coverage and pending bounds use ISO timestamps; JSON keeps Slack timestamps.
The status read calls no Slack API and starts no scan. If the daemon cannot be
observed, local configuration remains visible and live state is unknown. A
connected socket or valid configuration alone does not prove end-to-end delivery.

### Slack rejects a message with `invalid_blocks`

`rig queue show <qitemId> --json` records the failure as
`class=slack-invalid-blocks error=invalid_blocks` in the delivery transition.
Slack rejected that message's blocks, so OpenRig retains the notification as
undelivered and does not post the same payload again, including after a daemon
restart. The rejection is tied to the rendered payload: corrected content can
make a new attempt. Network failures, server errors and rate limits still retry
as before; a timed-out request remains uncertain until reconciliation.

The source seat gets a `slack-undeliverable` queue item explaining the failure.
Check the evidence links and message content, then send a corrected ask as a new
queue item. Close the original when you have handled it. If a long ask was split
into several messages, earlier parts may already be in Slack; the notice says
when only part of the ask was posted. A failed part never counts as delivery of
the whole ask.
