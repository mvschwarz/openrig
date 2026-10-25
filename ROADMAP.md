# Roadmap

These are things we'd welcome help with. Most came from the community, and most are small enough for one pull request.
This isn't a schedule or a promise: we release often, and an item ships when a good change for it lands.

To see what's being worked on, by release and theme, open the [OpenRig roadmap board](https://github.com/users/mvschwarz/projects/1).
Issues labelled `good first issue` are also listed on the [contribute page](https://github.com/mvschwarz/openrig/contribute).

## Planned for 0.7.2

- **Outside assistants over MCP (if ready):** Assistants such as ChatGPT and Claude Desktop find your team, delegate
  work, follow it and get the results through a maintained MCP server, locally or over an authenticated network
  connection.
- **More harnesses as seats (if ready):** One plug-in point for other coding-agent CLIs, with Hermes, OpenClaw and
  Cursor running as normal seats.
- **Accounts (if ready):** Each seat can use its own provider account, and an agent can move one seat to another account
  and keep its conversation.
- **Subscriptions (if ready):** One Fleet agent manages two registered Codex subscriptions across two Linux machines, following
  your standing preferences.
- **Member permissions (if ready):** Each seat gets its own permission rules, even when seats share a project folder.
- **Stream decisions (if ready):** Opt in, and observations on a rig's stream reach the work they belong to, with
  visible results and effects you can recover.
- **Named people in Slack (if ready):** Agents can address several named people in one Slack workspace, and each person
  sees and answers their own requests.

## How to help

1. Pick an item and comment on its issue to say you're working on it and coordinate with others. A maintainer can assign
   you to make that work visible. If it has no issue yet, open one first.
2. Read `CONTRIBUTING.md`, and ask your agent to use the `developing-openrig` skill. It's a map of how OpenRig is
   built, tested and changed.
3. Open a pull request that says what a user gets and how you verified it.

If more than one pull request arrives for the same item, we take the best one, and the first equivalent one breaks a
tie. Feel free to coordinate on the issue first.

## Testing

- **Behavioural scenarios for more command families.** `docs/as-built/test-layers.md` has a "Help wanted" list of
  `rig` command families that have no scenario yet, each with a suggested first check. One family per pull request is
  ideal.

## Agents and runtimes

- **Operator recovery for Pi and Oh My Pi seats** (#41).
- **More harnesses:** we're working out one way for any coding-agent CLI to plug into OpenRig. More on this soon
  (design discussion: #43).

## Slack

- **A DM or private channel for single-user setups** (#313).

## Reliability and everyday use

- **Draft-aware delivery** (#48): automated sends wait while someone is typing in a seat, or a seat can be set to
  inbox-only.
- **A host-aware resource budget for seats** (#80).
- **Predictable `rig up` over a stopped rig with the same name.**
- **Codex seats that leave a repository's tracked `AGENTS.md` alone** (related: #64).
- **Install and run on Node 26.**

Bugs aren't listed here. Please file them as issues; anything labelled `good first issue` is a good place to start.
