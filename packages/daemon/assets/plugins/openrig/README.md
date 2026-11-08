# openrig

Work with your OpenRig team from the coding agent you already use. Your agent can hand the team work, follow that work,
bring you the team's questions and read what it returns, through OpenRig's MCP server.

This plugin is for a person's own agent in an app such as Claude Code, Codex, VS Code, Copilot CLI or Cursor. The agents
on an OpenRig team load `openrig-core` instead.

## What it ships

- **The MCP server entry, in two forms:**
  - **In the Claude Code manifest:** `rig mcp serve --front-door`, acting as the seat you set in the plugin's settings.
    Claude Code substitutes that seat into the server's environment. An app that passes the seat on unfilled
    (`${user_config.seat}`) or empty gets a server with no seat (see "No seat" below); it never acts as a seat named
    after the placeholder.
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

- **No seat:** these apps can't set a seat for a plugin's server, so it starts with none. An app started from a shell
  where `OPENRIG_SESSION_NAME` (or the older `RIGGED_SESSION_NAME`) is set passes it on, but only for that launch: on
  macOS, reopening the app from the Dock drops it, and an already running VS Code keeps its own environment.
  - **What goes through without one:** messages (`rig_send`), new tasks (`rig_queue_create`) and chat
    (`rig_chatroom_send`) reach the team as an unknown sender, `unknown-mcp-` and eight hex digits, one per server. Each
    opens with a note saying why there's no seat and what the app's MCP client says it is. There's no return address,
    so your agent follows a task it created by its id (`rig_queue_show`). `rig_whoami` says why there's no seat and
    names the unknown sender.
  - **What needs a seat:** OpenRig answers `actor_required` to claim, update, hand off, unclaim and decide, which covers
    recording an answer to the team's questions. Listing the questions sent to you (`rig_queue_list` with `owned` or
    `mine`) needs the seat too. Set one to get the team's questions and replies.
  - Environment export needs an HTTP work grant, which a plugin's local server never has.
- **To give the app a seat,** add your own MCP server that runs `rig mcp serve --front-door` with
  `OPENRIG_SESSION_NAME=<address>` in its environment, and turn the plugin's `openrig` server off, so the app runs one
  OpenRig server. The plugin's skill stays installed. Verified on VS Code 1.145 and Cursor 3.27, where the team's
  questions then reach you and your answers are recorded, across a reopen:
  - **VS Code:** add it to your user `mcp.json` under a name other than `openrig`, such as `openrig-seat`, and disable
    the plugin's `openrig` in **MCP: List Servers**. Two servers named `openrig` are hard to tell apart, and starting
    one can stop the other.
  - **Cursor:** add it to `.cursor/mcp.json` (the project's or your user one), turn it on, and disable
    **openrig · Plugin** in **Customize → MCPs**.
  - **Copilot CLI:** add it the CLI's own way and turn the plugin's server off; not yet verified.

## What it doesn't do

- It adds no panel to the app, and nothing wakes your chat when the team finishes: ask your agent to check.
- Everyone using the app on this machine acts as the seat it names.
- It reaches a team on this machine.
- **Outside Claude Code and Codex,** until you give the app a seat, it hands the team work only as an unknown sender
  with no return address, and it can't record answers to the team's questions: see "No seat" above for how.
