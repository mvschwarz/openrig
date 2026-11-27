# openrig

Work with your OpenRig team from the coding agent you already use. Your agent can hand the team work, follow that work,
bring you the team's questions and read what it returns, through OpenRig's MCP server.

This plugin is for a person's own agent in an app such as Claude Code, Codex, VS Code, Copilot CLI or Cursor. The agents
on an OpenRig team load `openrig-core` instead.

## What it ships

- **The MCP server entry, in two forms:**
  - **In the Claude Code manifest:** `rig mcp serve --front-door`, started by the plugin's `scripts/run-rig.cjs` with the
    same `rig` its hooks run (see "Which `rig`" below), acting as the seat you set in the plugin's settings.
    Claude Code substitutes that seat into the server's environment. An app that passes the seat on unfilled
    (`${user_config.seat}`) or empty gets a server with no seat (see "No seat" below); it never acts as a seat named
    after the placeholder.
  - **In the root `plugin.json` and `mcp.json`** (the Agent Plugins 1.0 format, which VS Code, Copilot CLI and Cursor
    read): the same command with no seat. That format allows no per-person values, so it can't carry one. It runs `rig`
    from your PATH, not the plugin's launcher: VS Code and Copilot CLI expand `${PLUGIN_ROOT}` there and Cursor doesn't,
    so no one path to the launcher works in all three. Claude Code ignores these root files and runs only its own entry.
    Cursor reads them because `.cursor-plugin/plugin.json`, which carries only the plugin's name, version and
    description, is there; without it, Cursor runs the Claude Code entry.
  - Codex gets the server from one command (below).
- **`--front-door`** tells your agent the team's questions to its seat are yours to answer: it shows them to you and
  records only what you say, instead of working them itself as a team member would.
- **One skill,** `working-with-an-openrig-team`: the loop around the tools. It covers handing work to the team's lead,
  following it along its handoffs, answering the team's questions with your own words, reading the result and coming
  back to it later.
- **Hooks** that bring the team's questions into your chat without anyone asking your agent to check, in Claude Code
  and Codex (see "How the team's questions reach your chat" below). Other apps don't run them.

## How the team's questions reach your chat

When your agent hands the team work with an address of its own (`returnRoute` `auto` on `rig_queue_create`, the default
in Claude Code, or `rig queue create --return-route auto`), OpenRig gives that work an address
for your chat and records it with a key for the chat. In Claude Code the key is the chat's own `claude` process, so a
new chat in the same process (after `/clear`) still gets the earlier chat's tasks, and one resumed in a new process
(`claude --resume`) doesn't get them by itself. In Codex it's the session id Codex gives its commands and hooks.

- **Which setups they cover:**
  - **Claude Code:** `rig_queue_create` gives the work an address of its own by default, whether the plugin's OpenRig
    seat is set or blank. With a seat set, the seat stays the work's sender. Work handed over with `returnRoute: "self"`
    sends the team's questions to the seat's own address instead, which the hooks don't watch, so your agent finds them
    only when it checks (`rig_queue_list` with `owned`). In one of OpenRig's own seats there's no such default: that seat
    has its own delivery, and the server knows it's there from `OPENRIG_NODE_ID`, which OpenRig sets in its seats. If
    the MCP server's environment leaves that variable out (with `CLAUDE_CODE_MCP_ALLOWLIST_ENV` set, say), the server
    can't tell the seat from your own chat, and the seat's work can get an address its hooks don't watch. Keep
    `OPENRIG_NODE_ID` in that server's environment.
  - **`rig queue create --return-route auto` in the shell,** in Claude Code or Codex.
  - **Not covered: a Claude Code or Codex started from a shell where `OPENRIG_SESSION_NAME` is exported.** The hooks
    take a chat with that variable in its environment for one of OpenRig's own seats and don't run there, so nothing
    comes into the chat by itself, even when the MCP server gives the work an address of its own. Set the address in the
    plugin's OpenRig seat (in Codex, with `--env` on `codex mcp add`) instead of exporting it.
  - **Not yet: Codex through the MCP server.** Codex may not give the server the session id the key comes from, so its
    handovers get no key and nothing wakes for them. In Codex, hand work over with `rig queue create --return-route auto`
    in the shell.
- **What the hooks do:** they read only the addresses recorded under your chat's key, from OpenRig's own record, and
  check them for new tasks every 15 seconds: in Claude Code for up to two hours after each turn, in Codex while the
  session lasts. In Claude Code, a chat with no such address stops after its first read. In both, a read that fails (OpenRig
  restarting, say) is tried again after a longer wait each time, up to five minutes. In Claude Code, a new task wakes your agent between turns, not in the middle of one. In Codex, the
  hooks queue the task for the chat with `codex queue`, which starts a turn when the chat is idle. Each task names its
  sender as OpenRig recorded it, so your agent can see it's from the team it handed work to.
- **What they don't do:** they type nothing into any terminal, and they change nothing in OpenRig: they run `node` and
  `rig`. A chat that never handed work over this way has nothing to read, and they do nothing in OpenRig's own seats.
- **Which `rig`:** the hooks, and in Claude Code the MCP server, run the file `OPENRIG_RIG_BIN` names, else `rig` on your
  PATH, else the project's own `node_modules/.bin/rig` (in Claude Code, the session's project; in Codex, the session's
  folder), else the first `rig` on a login shell's PATH, run with that PATH. So an OpenRig installed inside one project is
  found only in sessions started there, and one installed after the app started is found once your login profile
  (`~/.zprofile` for zsh, `~/.bash_profile` or `~/.profile` for bash, not only `~/.zshrc` or `~/.bashrc`) puts its
  folder on PATH. With no `rig`, the hooks
  say once in a chat that the team's questions won't come in by themselves: once for the plugin's install, not in every
  session, and again only after a `rig` was found and then lost. Claude Code logs the MCP server's one line saying why it
  didn't start. The hooks themselves start with the `node` on the app's PATH, or the file `OPENRIG_NODE` names: set it
  in the environment the app starts with when `node` isn't on that PATH (a `node` from nvm, say).
- **Why Codex asks you to trust them:** Codex runs hooks outside its sandbox, so it asks you once before they run, and
  again after the plugin changes. Until you trust them, they don't run and your agent checks only when you talk to it.
- **When they start:** in a new session after you install the plugin, or after `/reload-plugins` in Claude Code.

## Before you install

1. OpenRig is installed and runs a team on this machine: `rig ps` lists it.
2. Pick an address for this app on that team, such as `cursor@my-team`. The queue takes work for it; nothing is
   launched. To tell the team what it's for, add it to a roster as a hosted member (`docs/reference/hosted-members.md`).
3. **Claude Code 2.1.119 or later.** On earlier versions, while the plugin's OpenRig seat is blank, Claude Code silently
   drops its MCP server: the skill loads, but your agent has no OpenRig tools.

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
Pressing Enter on the empty row closes it with no change. Then start a new session. With a seat set, the hooks still
bring in the team's questions about work your agent hands over (see "Which setups they cover" above).

**Codex**

Codex installs from its own folder, `openrig-codex`, which the OpenRig package makes from this one. Codex 0.171 reads
this folder's root `plugin.json`, the Agent Plugins manifest VS Code, Copilot CLI and Cursor read, and runs no hooks
from a plugin in that format. `openrig-codex` has the same skill, hooks and hook script with only Codex's own manifest,
so Codex runs the hooks.

Install the plugin for its skill and hooks, then connect the MCP server with your address:

```sh
codex plugin marketplace add "$(npm root -g)/@openrig/cli/daemon/assets/plugins/openrig-codex"
codex plugin add openrig@openrig-app
codex mcp add openrig --env OPENRIG_SESSION_NAME=<address> -- rig mcp serve --front-door
```

The hooks don't cover handovers through this MCP server yet. For the team's questions to come into the chat by
themselves, hand work over with `rig queue create --return-route auto` in the shell (see "Which setups they cover").
A Codex whose `codex queue` has no `--resume` (0.162.1, say) gets the team's tasks at the chat's next turn, not while
it's idle, and the hooks say so once in the chat; Codex 0.171.0 starts the turn by itself.

- **Added before from the `openrig` folder:** Codex answers that `openrig-app` is already added from a different source.
  Run `codex plugin marketplace remove openrig-app`, then the commands above.
- **A non-default OpenRig home:** Codex does not forward every shell environment variable to MCP servers by default. If
  your team runs on a non-default OpenRig home, add `--env OPENRIG_HOME=<that home>` to the `codex mcp add` line.
- **Approvals:** Codex may ask you to approve tools according to its approval settings. Create, claim and update change
  team state; tools that only read are marked read-only.

**VS Code, Copilot CLI and Cursor**

- **VS Code:** verified on 1.145. Older versions, such as 1.110, don't load Agent Plugins.
- **Cursor:** verified on 3.27, as a local plugin.
- **Copilot CLI:** verified on 1.0.107. Install from this repository's marketplace, and trust the folder when Copilot
  CLI asks:

  ```bash
  copilot plugin marketplace add mvschwarz/openrig
  copilot plugin install openrig@openrig-app
  ```

  Unlike the other apps, this installs the plugin from this repository's main branch, not from your OpenRig package, so
  its skill can be newer than the OpenRig you run.

  Copilot CLI also loads the skills in `~/.agents/skills`. Where OpenRig's own skills are installed there, it can choose
  OpenRig's `openrig-skills` skill before this plugin's `working-with-an-openrig-team`. If it does, it may ask for a
  skill pack that isn't there and get `pack_not_found`: ask it to use `working-with-an-openrig-team`.

In VS Code and Cursor, install the plugin from this folder with the app's own install-from-folder step. In VS Code
that's **Chat: Install Plugin from Source**; in Cursor, copy the folder to `~/.cursor/plugins/local/openrig` and reload.
The app starts one `openrig` server, `rig mcp serve --front-door`, from the root `mcp.json`, and should load the skill.

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
  OpenRig server. The plugin's skill stays installed. Verified on VS Code 1.145, Cursor 3.27 and Copilot CLI 1.0.107,
  where the team's questions then reach you and your answers are recorded, across a reopen:
  - **VS Code:** add it to your user `mcp.json` under a name other than `openrig`, such as `openrig-seat`, and disable
    the plugin's `openrig` in **MCP: List Servers**. Two servers named `openrig` are hard to tell apart, and starting
    one can stop the other.
  - **Cursor:** add it to `.cursor/mcp.json` (the project's or your user one), turn it on, and disable
    **openrig · Plugin** in **Customize → MCPs**.
  - **Copilot CLI:** add it, then turn the plugin's server off. Copilot CLI saves both, so the seat holds in new
    sessions:

    ```bash
    copilot mcp add openrig-seat --env OPENRIG_SESSION_NAME=<address> -- rig mcp serve --front-door
    copilot mcp disable openrig
    ```

## What it doesn't do

- It adds no panel to the app. Where its hooks don't run (apps other than Claude Code and Codex), nothing wakes your
  chat when the team asks or finishes: ask your agent to check.
- Everyone using the app on this machine acts as the seat it names.
- It reaches a team on this machine.
- **Outside Claude Code and Codex,** until you give the app a seat, it hands the team work only as an unknown sender
  with no return address, and it can't record answers to the team's questions: see "No seat" above for how.
