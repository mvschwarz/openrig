# factory-rsi — the single-rig RSI factory MVP

This rig IS a recursive-self-improvement loop. One workflow (`factory-rsi`)
moves one slice through the inner loop **plan → implement → check → review →
release**. Dogfood is decoupled from that gated loop: it continuously uses the
**shipped** product out-of-band and feeds its findings into the **next** plan
cycle. That feedback edge is the whole point — and it needs no human in the loop.

## How the loop runs

- The **engine routes the inner loop**, not the orchestrator. A failing check or
  review routes back to build for bounded remediation; a clean review proceeds
  to release prep. Nobody hand-relays a packet around the loop.
- **Dogfood is out-of-band.** It runs continuously against the SHIPPED product —
  not a second QA on the pre-release build artifact — and records findings that
  become the next plan's input. The RSI recursion stays ungated: dogfood findings
  feed the next plan with no human gate (a human MAY steer via the roadmap but is
  never required; there is no loop-stop in the MVP).
- **Findings are recorded state, not memory.** The next plan builds from the
  recorded dogfood findings — never a seat's chat history.
- **Exceptions go orchestrator-first** (the WF-5 dial); the human knows at
  altitude. A `max_hops` trip is an exception, and a resume grants exactly one
  more bounded window — the loop never runs away.
- **Publishing is a human act.** The release seat PREPARES notes/docs/PR and
  holds the ship decision at a human gate. No seat pushes, tags, or publishes.

## The seats

| Seat | Runtime | Does |
|---|---|---|
| `plan-planner` | claude-code | turns the corpus / previous findings into ONE buildable slice spec |
| `build-implementer` | claude-code | builds the slice, produces proof |
| `check-qa` | codex | checks the artifact; a failing check loops back to build |
| `review-reviewer` | codex | reviews (cross-runtime vs the builder) |
| `dogfood-tester` | codex | continuously USES the shipped product out-of-band; records findings that feed the next plan |
| `release-manager` | claude-code | prepares the release, holds the human gate |
| `orch-lead` | claude-code | the exception dial target — exceptions only |

Seats inherit their runtime's default model (no per-seat model pin): plan,
build, release, and orchestration run on claude-code; check, review, and dogfood
run on codex for cross-runtime diversity against the builder.

## Deployment

As a shipped starter this rig is workspace-agnostic — point
`rig up factory-rsi --cwd <repo>` at whatever real repository the loop should
improve, and the planner's product-intent corpus is that repo's real specs.
