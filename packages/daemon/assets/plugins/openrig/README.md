# openrig

Work with your OpenRig team from the coding agent you already use. Your agent can hand the team work, follow that work,
bring you the team's questions and read what it returns, through OpenRig's MCP server.

This plugin is for a person's own agent in an app such as Claude Code, Codex, VS Code, Copilot CLI or Cursor. The agents
on an OpenRig team load `openrig-core` instead.

## What it ships

- **The MCP server entry, in two forms:**
  - **In the Claude Code manifest:** `rig mcp serve --front-door`, acting as the seat you set in the plugin's settings.
    Claude Code substitutes that seat into the server's environment.
  - **In the root `plugin.json` and `mcp.json`** (the Agent Plugins 1.0 format, which VS Code, Copilot CLI and Cursor
    read): the same command with no seat. That format allows no per-person values, so it can't carry one. Claude Code
    ignores these root files and runs only its own entry. Cursor reads them because `.cursor-plugin/plugin.json`, which
    carries only the plugin's name, version and description, is there; without it, Cursor runs the Claude Code entry.
  - Codex gets the server from one command (below).
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

The plugin ships inside the OpenRig package, so you install it from there. Its marketplace is named `openrig-app`, because
OpenRig already uses `openrig` for the marketplace its own Codex seats load `openrig-core` from.

The commands below use `$(npm root -g)`, npm's global folder. If you installed OpenRig with another prefix, use that
prefix's `lib/node_modules` instead.

**Claude Code**

```sh
claude plugin marketplace add "$(npm root -g)/@openrig/cli/daemon/assets/plugins/openrig"
claude plugin install openrig@openrig-app
```

Set the plugin's **OpenRig seat** to your address (`/plugin`, then configure): type the address into the row, then save.
Pressing Enter on the empty row closes it with no change. Then start a new session.

**Codex**

Install the plugin for its skill, then connect the MCP server with your address:

```sh
codex plugin marketplace add "$(npm root -g)/@openrig/cli/daemon/assets/plugins/openrig"
codex plugin add openrig@openrig-app
codex mcp add openrig --env OPENRIG_SESSION_NAME=<address> -- rig mcp serve --front-door
```

- **A non-default OpenRig home:** Codex does not forward every shell environment variable to MCP servers by default. If
  your team runs on a non-default OpenRig home, add `--env OPENRIG_HOME=<that home>` to the `codex mcp add` line.
- **Approvals:** Codex may ask you to approve tools according to its approval settings. Create, claim and update change
  team state; tools that only read are marked read-only.

**VS Code, Copilot CLI and Cursor**

- **VS Code:** verified on 1.145. Older versions, such as 1.110, don't load Agent Plugins.
- **Cursor:** verified on 3.27, as a local plugin.
- **Copilot CLI:** not yet verified; the steps follow its documentation.

Install the plugin from this folder with the app's own install-from-folder step. In VS Code that's **Chat: Install Plugin
from Source**; in Cursor, copy the folder to `~/.cursor/plugins/local/openrig` and reload. The app starts one `openrig`
server, `rig mcp serve --front-door`, from the root `mcp.json`, and should load the skill.

- **No seat:** these apps can't set a seat for a plugin's server, so it starts with none. The exception is an app started
  from a shell where `OPENRIG_SESSION_NAME` (or the older `RIGGED_SESSION_NAME`) is set: its server acts as that seat.
  - **What needs a seat:** with none, OpenRig answers `actor_required` to the queue tools that change a task (create,
    claim, update, hand off, unclaim and decide, which covers handing work over and answering the team's questions) and
    to chatroom send. Listing the questions sent to you (`rig_queue_list` with `owned` or `mine`) needs the seat too.
    `rig_send` still sends, unsigned. `rig_whoami` says the server has no seat.
  - Environment export needs an HTTP work grant, which a plugin's local server never has.
- **One `openrig` server:** if something else in the app already provides an MCP server named `openrig` with your seat,
  use that one or the plugin's, not both.

## What it doesn't do

- It adds no panel to the app, and nothing wakes your chat when the team finishes: ask your agent to check.
- Everyone using the app on this machine acts as the seat it names.
- It reaches a team on this machine.
- **Outside Claude Code and Codex,** it can't hand work over or answer the team's questions until a seat is set: see "No seat"
  above.
