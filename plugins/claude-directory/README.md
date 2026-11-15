# openrig (skill edition)

Work with your OpenRig team from Claude Code. Your agent hands the team work, follows that work, brings you the team's
questions, records your answers and reads what the team returns. It does this with the `rig` command in your shell.

This is the edition in Anthropic's Claude directory. It ships one skill, `working-with-an-openrig-team`, and nothing
else: no MCP server, no hooks, no scripts.

## Before you start

1. OpenRig is installed and runs a team on this machine: `rig ps` lists it. Install OpenRig from https://openrig.dev.
2. Your agent suggests an address for itself on that team, such as `claude-app@my-team`. The queue takes work for it;
   nothing is launched.

Then ask your agent something like "have my OpenRig team look into X".

## The full plugin

OpenRig's own marketplace has the full plugin, which adds OpenRig's MCP server (typed tools, and the address set once
in the plugin's settings):

```sh
claude plugin marketplace add mvschwarz/openrig
claude plugin install openrig@openrig-app
```

## What it doesn't do

- It adds no panel, and nothing wakes your chat when the team finishes: ask your agent to check.
- It reaches a team on this machine.
- Anyone using Claude Code on this machine with the same address acts as that address.

## Privacy

OpenRig has no analytics, telemetry or crash reporting, and doesn't send your code, prompts, conversations or usage to
us. This skill runs the `rig` command on your machine, which talks to your own OpenRig daemon. Privacy policy:
https://openrig.dev/privacy. Terms: https://openrig.dev/terms. Support: https://github.com/mvschwarz/openrig/issues.
License: Apache-2.0 (LICENSE.md).
