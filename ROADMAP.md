# Roadmap

These are things we'd welcome help with. Most came from the community, and most are small enough for one pull request.
This isn't a schedule or a promise: we release often, and an item ships when a good change for it lands.

## How to help

1. Pick an item and comment on its issue to say you're working on it. If it has no issue yet, open one first.
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

- **Claude seats in `auto` permission mode** (#33).
- **Codex seats that can reach the local daemon by default** (#275), with an easy opt-out.
- **Custom Codex providers such as Bedrock** (#194): accept providers that authenticate with an environment key, and
  forward their token.
- **Claude usage-limit detection** (#99): show a seat as limited, with its reset time, as Codex seats already do.
- **Operator recovery for Pi and Oh My Pi seats** (#41).
- **New agent types:** OpenCode (#87, #227, #517), the Cursor CLI (#352), the Grok CLI (#522) and Devin (#44) are
  planned on a shared adapter.
  Design discussion: #43. Adapter pull requests are welcome once that adapter lands.

## Slack

- **A DM or private channel for single-user setups** (#313).
- **A channel map** (#192): one channel per seat, keyed by channel ID.

## Reliability and everyday use

- **A configurable readiness window for fresh launches** (#182), so seats under load don't time out at a fixed 30
  seconds.
- **Draft-aware delivery** (#48): automated sends wait while someone is typing in a seat, or a seat can be set to
  inbox-only.
- **A host-aware resource budget for seats** (#80).
- **Predictable `rig up` over a stopped rig with the same name.**
- **A "merged" stage in the project view** for teams that integrate on a branch other than main (#402).
- **Codex seats that leave a repository's tracked `AGENTS.md` alone** (related: #64).
- **Install and run on Node 26.**

Bugs aren't listed here. Please file them as issues; anything labelled `good first issue` is a good place to start.
