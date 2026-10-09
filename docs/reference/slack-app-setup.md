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
2. Sign in to Slack if asked, pick the workspace, review the prefilled manifest, and click
   **Create**.
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
  attachments to Slack), `app_mentions:read` (receive @-mentions of the app), and `reactions:read`
  (receive emoji reactions). `rig slack verify` warns when one of these is missing (if Slack returns
  the granted scopes) but does not require them, so a READY from verify does not prove attachments,
  mentions or reactions will work.

If a feature scope was not granted, the effect differs by feature:

- **Attachments** (`files:read`, `files:write`): the file download or upload call fails. A
  message with an attachment that could not be downloaded is still delivered, with the failed
  file named in it. A post whose attachment could not be uploaded still delivers its text, and
  the failure appears only in the daemon log (`rig daemon logs`).
- **Mentions** (`app_mentions:read`): Slack does not deliver `app_mention` events to the app.
  Only `rig slack verify` warns that the scope is missing; nothing reports the missing events.
- **Reactions** (`reactions:read`): Slack does not deliver `reaction_added` events, so a reaction
  on an ask doesn't reach the asking agent. A reply in the ask's thread still does.

So after installing, compare the granted scopes Slack shows for the app with all seven scopes that
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

By default every human-bound item posts to the one channel from `rig slack setup --channel`.
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
  --reply-to <the inbound reply's row>`. A message the human starts (or a reply in a thread OpenRig does not know) goes to
  the connector's inbound destination, whichever channel it is in. Missed-message recovery
  (below) covers the default channel only.

Invite the app to every mapped channel (`/invite @OpenRig`). `rig slack verify` checks
membership in the default channel and every mapped channel, and reports NOT ready until the
app is in all of them. A saved change reaches a running connector when it next rewires:
`rig slack disable` then `rig slack enable`, or a daemon restart. The TUI's Connections page
says whether the running configuration matches the file.

The map is stored as `channelMap` in `slack-connector.json`, as a list of `{ "match", "channel" }`
entries. Saving refuses any other field. A field written by a newer OpenRig is ignored when the
connector reads the file, and `rig slack status` names it. Private channels and direct messages
are not supported targets.

## Reconnect recovery and status

The daemon scans available top-level messages in the configured channel after a
Socket Mode connection and on its existing five-minute retry cadence. Recovered
tasks say **Recovered after a gap** and show the original Slack posting time.
They use the same sender admission, routing, attachment handling, fixed identity
and dead-letter path as live messages. A durable dead letter is custody of a
failed delivery, not successful delivery.

Recovery keeps a per-channel checkpoint across reconnects, restarts and channel
switches. On upgrade it initializes once from the newest retained accepted
channel landing; without such evidence it starts at feature adoption. **Older
history is unknown.** New live messages never move the recovery checkpoint. A
partial scan resumes its saved interval; only an exhausted interval advances the
covered boundary. Each new interval ends five seconds before the local clock to
allow recent messages to become visible; larger clock skew or visibility lag is
not covered by that margin. A corrupt or unreadable checkpoint leaves recovery unavailable
and preserves the existing file; live inbound continues.

Each pass admits at most four pages, 100 entries and 15 seconds of work, with a
five-second history-request ceiling. Work already started on a message, such as
an attachment transfer, is not cancelled by these limits or by a stop, and a new
pass waits for it to finish. Rate limits retain Slack's Retry-After across restart.
Transport and server failures use a five-second backoff unless Slack supplies Retry-After.
When Slack reports a plan history limit, recovery still lands the available page
and advances normally, retaining an older-history limitation in status across restarts.
Missing bot credentials, history scope, membership, retention limits and API
failures appear as recovery limitations. No additional scope is required to keep
live delivery working. Thread-reply catch-up and dead-connection detection remain
outside this recovery scope; global chronological order is not promised.

`rig slack status` retains local configuration checks and adds a bounded daemon
snapshot: socket state/generation, last event, recovery interval/state/reason,
retry time and accepted/dead-lettered recovery counts since the connector last
started (they reset when it is enabled or disabled, and when the daemon restarts).
It also reports the durable dead-letter backlog: the retained records for inbound messages,
reactions and click answers that await retry, counted from both dead-letter files so the number
survives a restart, and shown as unknown with a reason (and no count) when a file cannot be read.
Human-readable coverage and pending bounds use ISO timestamps; JSON keeps Slack timestamps.
The status read calls no Slack API and starts no scan. If the daemon cannot be
observed, local configuration remains visible and live state is unknown. A
connected socket or valid configuration alone does not prove end-to-end delivery.
