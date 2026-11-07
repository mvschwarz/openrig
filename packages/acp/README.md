# @openrig/acp

OpenRig as an agent in apps that speak the [Agent Client Protocol](https://agentclientprotocol.com) (ACP), such as
Zed and JetBrains AI Assistant. Your prompt goes to your OpenRig team as a queue row. The app shows who has the work
and their notes as it moves, any question the team asks you as a choice, and the team's result as the reply.

This package has one command, `openrig-acp`. It starts `rig acp serve` from the exact `@openrig/cli` version it
depends on, so ACP apps and the ACP registry can launch it with `npx`.

## What you need

- OpenRig on this computer, with its daemon running (`rig daemon start`) and a team.
- The seat that receives your team's new work, set once with `rig config set acp.to <member@rig>`, or passed as
  `--to <member@rig>`.
- You, as a person OpenRig knows: the default person (`rig gateway default <id>`), or `--as <address>`.

The app's sign-in step, "OpenRig on this machine", checks that the daemon answers and that it can tell who you are.
This agent talks only to the OpenRig daemon on this computer.

## In an app, without the registry

Add a custom agent whose command is `npx` with the arguments `@openrig/acp@<version>`, plus `--to <member@rig>` if
you haven't set `acp.to`. In Zed's `settings.json`:

```json
"agent_servers": {
  "OpenRig": { "type": "custom", "command": "npx", "args": ["@openrig/acp@<version>", "--to", "lead@my-team"] }
}
```

If `rig` is already installed, `rig acp serve` is the same agent without this package.

Guide: `rig context get reference/acp-agents.md#openrig-as-an-agent-in-acp-apps`.
