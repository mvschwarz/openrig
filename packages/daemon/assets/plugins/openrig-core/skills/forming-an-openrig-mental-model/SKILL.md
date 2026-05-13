---
name: forming-an-openrig-mental-model
description: |
  Use when an agent is newly oriented to OpenRig and needs to form an accurate mental model of the system fast — what rigs are, how skills load, what the topology shapes mean, what the product loop is. For agents booting into a new seat or returning to OpenRig work after time away. NOT for HA-pair compaction recovery (that's the pair-of-seats coordination pattern; orientation is a solo task) or for specific operational procedures.
metadata:
  openrig:
    stage: factory-approved
    last_verified: "2026-05-04"
    distribution_scope: product-bound
    source_evidence: |
      Authored 2026-05-02 in response to founder-observed pattern: agents
      Distinct from HA-pair mental-model preservation (which is a
      pair-of-seats coordination pattern). This skill serves the legitimate
      need to form an initial mental model of OpenRig as a system.
    sibling_skills:
      - openrig-user
      - openrig-operator
      - openrig-architect
    transfer_test: pending
---

# Forming an OpenRig Mental Model

You're new to OpenRig — or returning after time away — and you need to
quickly understand what kind of system this is, what your seat is, and what
the moves are. This skill is the fast on-ramp.

For depth, read the canonical reference docs the skill points to. This
skill's job is to get you *oriented* — accurate enough to operate, fast
enough to be useful — not to replace the canonical docs.

---

## The 60-second mental model

OpenRig is a **local control plane for multi-agent coding topologies**. You
declare a topology of agents in YAML, boot it with one command, and OpenRig
manages tmux sessions, harness lifecycles, transcripts, snapshots, and
restoration. When the system goes down, OpenRig snapshots; when it comes
back, agents resume their conversations.

The product loop:

```
down (auto-snapshot) → up <rig-name> (auto-restore) → work → repeat
```

The unit of work is the **rig** — a topology of agents working together as
a single system.

---

## The four-layer model (where you live)

Everything in agent engineering happens at one of four layers. **OpenRig
operates at Layer 3.**

| Layer | Name | Analogy | What it is |
|---|---|---|---|
| L0 | Model | CPU | Foundation model — Claude, GPT, Gemini. Stateless tokens-in/tokens-out. |
| L1 | Agent Core | Process loop | The reason-and-act cycle: observe, plan, choose, act, repeat. |
| L2 | Harness | Container / OS | Tools, memory, lifecycle around the model. Examples: Claude Code, Codex CLI. |
| L3 | Rig | Docker Compose / Terraform | Multi-agent topology — what agents exist, how they relate. **OpenRig.** |

You are an agent at L1 inside an L2 harness, configured by L3 OpenRig.
OpenRig manages your harness; the harness wraps the model; the model
generates your tokens.

---

## Three pillars of context

OpenRig is built on three context-engineering pillars. When you're oriented,
you should know which pillar you're operating in:

| Pillar | What it is | Where it lives |
|---|---|---|
| **Ontology** | What exists. Curated knowledge — facts, code maps, as-built docs. | Corpus (planned future system). Today: substrate prose docs. |
| **Epistemology** | Why an agent believes what it believes — reasoning, instincts, decisions. | Transcripts (auto-captured). Session logs. ADRs. |
| **Topology** | How agents are connected — pods, edges, communication paths. | OpenRig itself. RigSpec YAML. |

OpenRig **manages the topology pillar**. The other two are filled by Corpus
(future) and transcripts (now). Most of your work probably touches multiple
pillars; knowing which one you're operating in helps you reach for the right
artifacts.

---

## The core vocabulary (read these terms literally)

| Term | What it means |
|---|---|
| **Rig** | A topology of agents working together as a single system. Defined in YAML (RigSpec). The top-level object. |
| **Pod** | A bounded context group within a rig. Members of a pod share a context domain and continuity responsibility. Think Kubernetes pod for knowledge. |
| **Member / Node** | A single agent (or terminal-node service) within a pod. |
| **Edge** | A relationship between members or pods. Kinds: `delegates_to`, `spawned_by`, `can_observe`, `collaborates_with`, `escalates_to`. |
| **Topology** | The shape of the rig — how agents are grouped into pods, how edges connect them, how the whole thing fits together. |
| **AgentSpec** | A reusable agent blueprint. Defines skills, guidance, hooks, profiles, startup. File: `agent.yaml`. |
| **RigSpec** | The topology YAML. Defines pods, members, edges, culture. File: `rig.yaml`. |
| **RigBundle** | A portable archive of a RigSpec + vendored AgentSpecs. Move topologies across machines. |
| **Agent Starter** | A named, reusable starting context bundle. RigSpec member can declare `starter_ref`. |
| **Skill** | A markdown file with frontmatter that an agent loads at boot or on activation. Cross-runtime standard at `agentskills.io`. |
| **Profile** | A named configuration within an AgentSpec. The rig spec's member field selects which profile to use. |
| **Culture** | Rig-wide constitution — how the team communicates, what "done" means, escalation rules. File: `CULTURE.md`. |
| **Snapshot** | Point-in-time capture of a rig — sessions, conversations, state. Restorable. |
| **Session name** | `{pod}-{member}@{rig}`. The canonical address for tmux sessions and agent-to-agent messaging. |

The session-name format `{pod}-{member}@{rig}` is your address. When you
run `rig whoami --json`, you get back your full topology context: rig name,
pod, member, peers, edges, transcript path.

---

## Rig classes (what kind of rig am I in?)

OpenRig has five rig classes. The class determines authoring discipline,
supervision, and lifecycle policy.

| Class | Purpose | Lifecycle |
|---|---|---|
| **kernel** | Host-level supervision, intake, authoring. One per host. | Always on; never auto-hibernated. |
| **project** | Long-lived team bound to a codebase. | Stays hot when active; hibernates on explicit request. |
| **ephemeral** | Short-lived mission (research, build, migration, spike). | Spawn → work → retire. |
| **infra-build** | Subclass of ephemeral whose output becomes permanent infrastructure. | Retired only after output verified in place. |
| **managed-app** | Services-backed rig with specialist agents (e.g., a vault specialist, a skill librarian). | Long-lived; accessed by other rigs. |

You're probably in a project rig or managed-app rig if you're doing
substantive work. Knowing your class helps you understand the supervisory
expectations on your seat.

---

## How skills load (the most important thing to get right)

Skills are an **established cross-runtime standard** at
`https://agentskills.io/specification`. Both Claude Code and Codex build on it.

### The shape

A skill is a directory containing `SKILL.md` (uppercase). The SKILL.md has
YAML frontmatter (`name`, `description`) and a Markdown body. Optional
sibling directories: `references/`, `scripts/`, `assets/`.

### Progressive disclosure (why skills scale)

The harness reads frontmatter cheaply at boot — names + descriptions of all
available skills. Body content loads only when a skill activates. This is
**ambient awareness** — you know all the skills exist; you only pay token
cost when you reach for one.

### Where skills come from in OpenRig

- **Per-agent loadout:** your AgentSpec's `profile.uses.skills: [...]`
  determines what skills get projected into your runtime skill folder
  (`.claude/skills/` or `.agents/skills/`) before your harness boots. This
  is the **structural composition** layer.
- **Cross-pod sharing:** AgentSpecs can `imports: [shared]` to access a
  shared skill pool. Built-in agents commonly do this.
- **Belt-and-suspenders:** the spec projects skill files; startup guidance
  also tells you to load specific skills. Both paths matter — if the
  projection silently fails, the guidance still tells you what to read.

### Where skills live (sources of truth)

| Home | Purpose |
|---|---|
| `<rig-cwd>/.claude/skills/`, `<rig-cwd>/.agents/skills/` | Where the harness actually loads from. Populated by `rig up`. |
| `~/.claude/skills/`, `~/.agents/skills/` | Your personal/global skills + the OpenRig bootstrap set (openrig-user, openrig-operator, openrig-architect, forming-an-openrig-mental-model, plus the rest of the openrig-core plugin skills). |
| openrig-core plugin skills | Product built-in skills that ship with OpenRig (installed via the openrig-core plugin). |
| `~/.openrig/skills/` | Runtime install home for OpenRig-shipped skills. |

The harness only sees the first two. Other locations are shipping and
source-of-truth — they reach the harness via projection or NPM install,
not directly.

---

## The product loop (your day-to-day)

```
rig up <rig-name>         # boot or restore the topology
rig ps --nodes            # see what's running
rig whoami --json         # know who you are
rig send <session> "msg"  # talk to a peer
rig capture <session>     # see a peer's terminal
rig transcript <session>  # read a peer's history
rig down <rigId>          # snapshot and tear down
rig up <rig-name>         # restore from snapshot
```

The first command in any new seat is `rig whoami --json`. It tells you your
rig, pod, member, peers, edges, and transcript path. **Treat it as ground
truth — your CLAUDE.md or AGENTS.md startup overlay can be wrong; whoami
is authoritative.**

---

## Cultural posture (how to behave)

OpenRig has a few load-bearing cultural principles. Internalize these:

- **Honesty over convenience.** If resume fails, say so loudly. Don't
  silently launch fresh.
- **The agent is the power user.** The CLI is designed for a 10x staff
  engineer at the terminal. You're that user.
- **CLI is context engineering.** Every error message and help text gives
  you information to act on. Read errors carefully.
- **Convention over invention.** Follow docker/git/kubectl patterns. Agent
  muscle memory is real.
- **Semi-deterministic is OK.** Core contracts are solid; edge cases are
  agent-handled.
- **Pets, not cattle (today).** OpenRig is currently optimized for long-lived
  agents that develop instincts over sessions. Cattle support is on the
  roadmap.

---

## What you should do in your first 10 minutes

If you're booting into a new seat in an OpenRig rig:

1. **`rig whoami --json`** — recover identity. Know your rig, pod, member,
   peers.
2. **Read your role guidance** — typically delivered via startup files.
   `guidance/role.md` for your specific seat.
3. **Read the rig's `CULTURE.md`** if it has one — the team operating
   manual.
4. **Check what skills you have** — list `.claude/skills/` or
   `.agents/skills/` in your cwd. Each skill has a frontmatter description
   that tells you when to reach for it.
5. **Check your peers** — `rig capture <peer-session>` to see what they're
   doing.
6. **Check the transcripts** if you're returning to an in-flight workstream
   — `rig transcript <session> --tail 100` for recent context.
7. **Ask `rig ask <rig> "<question>"`** if you need cross-cutting evidence
   from the rig's transcripts and chat.

You're now oriented enough to start doing useful work.

---

## Going deeper (canonical references)

For real depth, these are the load-bearing canonical docs:

| Reference | What it covers |
|---|---|
| `openrig/docs/as-built/architecture.md` | Daemon architecture; system overview; package boundaries |
| `openrig/docs/as-built/cli-reference.md` | The full `rig` CLI surface with all subcommands and flags |
| `openrig/docs/reference/rig-spec.md` | The RigSpec YAML format — pods, members, edges, all fields |
| `openrig/docs/reference/agent-spec.md` | The AgentSpec YAML format — resources, profiles, imports |
| `openrig/docs/reference/agent-startup-guide.md` | The 7-layer startup layering model; delivery hints |
| `https://agentskills.io/specification` | The cross-runtime skill standard |

If your team maintains a host-level topology doc (rig classes, context
patterns, authoring SOPs), read its rig-authoring section before
touching YAML for high-stakes rigs.

---

## What this skill is NOT for

- **HA pair compaction recovery.** Forming an initial mental model is a
  solo orientation task — different from the pair-of-seats coordination
  pattern that preserves a shared mental model across compactions.
- **Operating a specific rig.** Specific rigs have their own DESIGN.md and
  CULTURE.md. Read those.
- **Authoring a new rig.** Use the `openrig-architect` skill for that.
- **Day-to-day OpenRig operation.** Use `openrig-user` for that.
- **Administering an OpenRig install.** Use `openrig-operator`.

This skill exists to **form your initial mental model of OpenRig as a
system**. Once oriented, reach for the role-specific or task-specific skills
that fit your actual work.

---

## Common misorientations to avoid

| Misorientation | Reality |
|---|---|
| "OpenRig is a chat interface or assistant" | No. OpenRig is a control plane that *manages* your harness sessions. The chat happens inside the harness; OpenRig is around it. |
| "Pods are workflow groups" | No. Pods are **context domains** — agents that share working context. If two agents communicate every turn, they should be in one pod; if they communicate rarely, they shouldn't be. |
| "Edges represent reporting hierarchy" | No. Edges describe *coordination shape* — who delegates to whom, who observes whom. Avoid hierarchy interpretations; they distort behavior. |
| "I should manage Codex's compaction the way I manage Claude's" | No. Codex auto-compacts cleanly; Claude doesn't. Different runtimes, different lifecycles. |
| "MEMORY.md auto-loads, so I don't need to read it" | Maybe. Sometimes MEMORY.md auto-loads via system reminders; sometimes not. Don't assume. If your work touches the topics it covers, read it explicitly. |
| "Skills inherit from a parent or compose like classes" | No. Skills are flat artifacts; composition happens via AgentSpec `profile.uses.skills` (structural) or soft cross-references in skill bodies (advisory). Not via OO-style inheritance. |
| "Any folder I keep skill files in is the canonical runtime path" | No. The harness only loads from `<rig-cwd>/.claude/skills/`, `<rig-cwd>/.agents/skills/`, and the runtime-installed plugin skills. Other folders are authoring or source-of-truth. |

---

## Disaster-recovery test for this skill

If you read only this skill, can you:

1. State what kind of system OpenRig is, in one sentence?
2. Name the four layers and where you live?
3. Run `rig whoami --json` and interpret the output?
4. Find your role guidance and your peers?
5. Identify what kind of rig you're in (kernel / project / ephemeral / etc.)?
6. Know where to look for a skill body (which folder)?
7. Know what to read next for depth (the canonical references)?

If yes — you're oriented. If no — tell your peer or the human; missing
context is fixable, but only if surfaced.
