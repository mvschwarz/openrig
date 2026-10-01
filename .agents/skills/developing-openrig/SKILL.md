---
name: developing-openrig
description: "Use when changing OpenRig's own source in a clone of the openrig repository: finding which package or file owns a behaviour, choosing which tests to run, testing a change without disturbing the OpenRig daemon your own session runs on, judging whether a diff touches a high-risk area, or preparing a pull request. Not for operating rigs (openrig-skills) or designing rig topologies."
---

# Developing OpenRig

This skill is a map to the other maps. Each one is incomplete and may be stale: where a map and the code disagree, the
code is right, and fixing the map is a welcome contribution.

## First: which OpenRig are you in?

If you are an agent running inside OpenRig, two different OpenRigs are in play:

- **The installed one runs your session.** `rig --version` and `rig daemon status` describe it.
- **The checkout is what you're changing.** `git rev-parse HEAD` describes it.

Restarting the installed daemon does not run your checkout, and stopping it stops the agents running on it, including
you. Test your change with the repo's own harnesses, which start a private daemon and tmux server (see "Test it" below),
not by restarting the daemon you live in.

## Find your way

| You want to know | Read | How much to trust it |
|---|---|---|
| How the packages fit, the request path, where to add a command, route, migration, adapter, skill, context pack or scenario | [`ARCHITECTURE.md`](../../../ARCHITECTURE.md) | Checked against the commit it names; counts come with the command to refresh them |
| Whether your change touches a high-risk area, what depends on it, what broke there before | [`docs/as-built/arteries.md`](../../../docs/as-built/arteries.md) | Incomplete by design: absence from it doesn't make a change safe |
| What to run before you push, and what each layer can and can't prove | [`docs/as-built/test-layers.md`](../../../docs/as-built/test-layers.md) | Checked against the commit it names |
| The exact behaviour of a `rig` command | `rig <command> --help` on the running binary, then `packages/cli/src/commands/` | The binary and the code win over any document |
| A subsystem in depth | [`docs/as-built/`](../../../docs/as-built/README.md) | Most modules predate 0.6; check each one's `last-verified-against-source` marker against `git log` before relying on it |
| Rig spec, agent spec and other user-facing reference | [`docs/reference/`](../../../docs/reference/) | Ships to every user; if you find drift, fix it there |
| How to open a good pull request, and what review looks like | [`CONTRIBUTING.md`](../../../CONTRIBUTING.md) | Current |

If none of these answers your question, search the code before inventing an answer. A missing map is worth an issue.

## Before you change an artery

If your diff touches anything in `arteries.md` (message delivery, launch and resume, the queue, rig identity, skill
projection, process observation, migrations, restore):

1. Read the artery row: what depends on it, and the past regressions listed there.
2. Describe the downstream effect in your pull request, not just the diff.
3. Add or extend a stub-agent scenario, or say precisely why the stub can't exercise it and what you ran instead.

## Test it

The short version is `npm run build`, `npm run lint`, `npm test`. `test-layers.md` has the full ladder, including the
stub-agent scenarios, which run the real CLI, daemon, tmux and SQLite with scripted agents and no model cost.

- The scenario runner starts its own daemon and tmux server and drops your session's `TMUX` and daemon variables, so
  it won't touch the daemon your session runs on.
- A stub proves OpenRig's own plumbing, not how Claude Code or Codex behave. Say which you exercised.

## How we judge changes

OpenRig is a coordination layer for a trusted environment: it should help agents and people keep work flowing.

- A change that removes friction, or makes state more truthful, is usually welcome.
- A change that adds a refusal, a prompt or a required step needs the concrete case in CONTRIBUTING.md: who is
  harmed, how, and what it costs everyone else.
- One concern per pull request. Keep the diff reviewable in one sitting.

## When the map is wrong

Fix it in the same pull request, or open an issue. Update a document's `last-verified-against-source` marker only when
you have actually checked it against that commit.
