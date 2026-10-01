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

8. Run `rig slack setup --channel <channel-id> --secrets-env-file <path>`, then
   `rig slack verify`, then `rig slack enable`.
9. Invite the bot to the channel you configured (`/invite @OpenRig` in that channel).

## What the app asks for

Run `rig slack manifest --json` for the exact list and the reason for each scope. There are two
groups:

- **Baseline scopes**: posting messages, reading message history in public channels the app is
  a member of, and reading channel details.
  `rig slack verify` checks these.
- **Feature scopes**: `files:read` (download attachments people send), `files:write` (upload
  attachments to Slack), and `app_mentions:read` (receive @-mentions of the app). `rig slack verify`
  does **not** check these, so a READY from verify does not prove attachments or mentions will
  work.

If a feature scope was not granted, the effect differs by feature:

- **Attachments** (`files:read`, `files:write`): the file download or upload call fails. A
  message with an attachment that could not be downloaded is still delivered, with the failed
  file named in it. A post whose attachment could not be uploaded still delivers its text, and
  the failure appears only in the daemon log (`rig daemon logs`).
- **Mentions** (`app_mentions:read`): Slack does not deliver `app_mention` events to the app, and
  nothing in OpenRig reports that they are missing.

So after installing, compare the granted scopes Slack shows for the app with all six scopes that
`rig slack manifest --json` lists.

The app subscribes to messages in public channels it is a member of (`message.channels`) and to
mentions of the app (`app_mention`). It does not request direct-message or private-channel access.

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
