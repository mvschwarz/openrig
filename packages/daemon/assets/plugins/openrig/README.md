# openrig

Work with your OpenRig team from the coding agent you already use. Your agent can hand the team work, follow that work,
bring you the team's questions and read what it returns, through OpenRig's MCP server.

This plugin is for a person's own agent in an app such as Claude Code or Codex. The agents on an OpenRig team load
`openrig-core` instead.

## What it ships

- **The MCP server entry**, in the Claude Code manifest only: `rig mcp serve --front-door`, acting as the seat you set in
  the plugin's settings. Claude Code substitutes that seat into the server's environment. Codex doesn't, so the plugin
  ships no shared MCP file, and Codex gets the server from one command (below).
- **`--front-door`** tells your agent the team's questions to its seat are yours to answer: it shows them to you and
  records only what you say, instead of working them itself as a team member would.
- **One skill,** `working-with-an-openrig-team`: the loop around the tools. It covers handing work to the team's lead,
  following it along its handoffs, answering the team's questions with your own words, reading the result and coming
  back to it later.
- **No hooks.** Nothing runs on your agent's prompts or sessions.

## Before you install

1. OpenRig is installed and runs a team on this machine: `rig ps` lists it.
2. Pick an address for this app on that team, such as `cursor@my-team`. The queue takes work for it; nothing is
   launched. To tell the team what it's for, add it to a roster as a hosted member (`docs/reference/hosted-members.md`).

## Install

**Claude Code**

The plugin ships inside the OpenRig package, so you install it from there:

```sh
claude plugin marketplace add "$(npm root -g)/@openrig/cli/daemon/assets/plugins/openrig"
claude plugin install openrig@openrig
```

Set the plugin's **OpenRig seat** to your address, then start a new session.

**Codex**

Install the plugin for its skill, then connect the MCP server with your address:

```sh
codex plugin marketplace add "$(npm root -g)/@openrig/cli/daemon/assets/plugins/openrig"
codex plugin add openrig@openrig
codex mcp add openrig --env OPENRIG_SESSION_NAME=<address> -- rig mcp serve --front-door
```

## What it doesn't do

- It adds no panel to the app, and nothing wakes your chat when the team finishes: ask your agent to check.
- Everyone using the app on this machine acts as the seat it names.
- It reaches a team on this machine.
