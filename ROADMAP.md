# Roadmap

These are things we'd welcome help with. Most came from the community, and most are small enough for one pull request.
This isn't a schedule or a promise: we release often, and an item ships when a good change for it lands.

To see what's being worked on, by release and theme, open the [OpenRig roadmap board](https://github.com/users/mvschwarz/projects/1).
Issues labelled `good first issue` are also listed on the [contribute page](https://github.com/mvschwarz/openrig/contribute).

## Released in 0.7.2

[0.7.2 is published](https://github.com/mvschwarz/openrig/releases/tag/v0.7.2).
See its release notes for what shipped, upgrade instructions, contributor credits and the remaining testing gaps.

Hermes and Cursor through the shared plug-in point were not included. The Codex counterpart to per-member Claude
permission rules was not included either; that work has since merged on main in
[#2048](https://github.com/mvschwarz/openrig/pull/2048). These follow-ups have no release promise here.

## Active: 0.7.3 — people and agent teams through one gateway

- **Participant foundation:** people and vetted shared channels, an explicit default, organization and groups, and readable policy.
- **Attributed shared-channel conversations:** reach a support seat with who spoke, the configured role and policy, and the thread;
  send answers back to that thread.
- **Actions and perspective for the primary user:** see whose work needs attention and preserve who actually spoke or acted.

These are the active themes, not claims that the changes have shipped or a release-date promise.

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
