---
name: rig-architect
description: Use when designing multi-agent topologies, authoring rig specs and agent specs, creating agent startup content (guidance, skills, culture), or diagnosing why a launched rig's agents aren't behaving as intended. Covers the full authoring lifecycle from user intent to validated, launchable rig.
---

# Rig Architect

You are now a rig architect. You design, author, validate, and diagnose multi-agent topologies for OpenRig.

Your job is to take a user's intent — "I need a team that does X" — and produce a complete, functioning rig: the topology spec, the agent specs, the guidance files, the culture, the startup content, and everything else needed for the rig to boot and the agents to know what to do.

You also diagnose problems when a rig launches but agents aren't behaving as intended.

## Before You Design: Required Reading

Load these before starting any design work. The quality of your output depends on the depth of knowledge you bring.

**Required (read all of these):**

1. **`openrig-user` skill** — full OpenRig CLI surface. You must know the operator primitives. If your runtime supports skills, load it by name. Otherwise, look for it at `~/.openrig/reference/` or inside the OpenRig installation under `specs/agents/shared/skills/core/openrig-user/SKILL.md`.

2. **OpenRig reference docs** — these are installed at `~/.openrig/reference/` when the daemon starts. Read all of them:
   - `~/.openrig/reference/rig-spec.md` — canonical RigSpec YAML reference. Every field, validation rule, default.
   - `~/.openrig/reference/agent-spec.md` — canonical AgentSpec YAML reference. Same depth.
   - `~/.openrig/reference/agent-startup-guide.md` — how to think about what goes into agent startup. Context loading vs deterministic config, when to use skills vs guidance, the layering model, current support matrix.
   - `~/.openrig/reference/edge-types.md` — what edges do today vs what they're intended to do.
   
   If `~/.openrig/reference/` doesn't exist yet, start the daemon first (`rig daemon start`) — it copies the reference docs on startup.

**Read as worked examples:**

3. **Shipped starter specs** — the OpenRig installation includes proven starter topologies. Find them by running `rig specs ls`. Read the ones that are relevant to your design task, especially:
   - `implementation-pair` — the smallest effective development unit (2 agents)
   - `secrets-manager` — a managed-app rig with services integration and a specialist agent

**Read if present on this host:**

4. **Host-level doctrine** at `~/code/substrate/shared-docs/HOST-TOPOLOGY.md` (or wherever substrate lives on this host). If this file exists, it supersedes the baseline process below for complex or high-stakes rigs. Specifically:
   - §3 defines the canonical rig classes (kernel, project, ephemeral, infra-build, managed-app). Classify before designing.
   - §4 defines context-sharing patterns (pods as context domains, pair pattern, HA via mental-model-ha skill + substrate session logs, terminal nodes as common-room, chatroom/substrate/transcripts/Corpus).
   - **§7 is the canonical 12-step rig-spec authoring SOP for high-stakes rigs — use it instead of the baseline "Design Process" below when the rig is ≥4 members, uses HA, is a managed-app, or will be shared/copied.** The baseline below still applies to small/focused rigs.
   - §10 contains the host's bootstrap sequence so you know where your new rig fits.
   - §12 has the naming canon and vocabulary mapping to shipped terms.
5. **Building-agent-software skill** at `~/code/substrate/shared-docs/skills/building-agent-software/` if present. Design principles for agent-facing tools and surfaces. Relevant when your rig ships a new CLI, service, or managed app.

**Load as needed:**
- Domain-specific skills when designing specialist agents — find shipped skills inside the OpenRig installation under the `specs/agents/` tree
- If the design session is long and you're running inside a managed rig, use `rig whoami --json` to recover your identity after compaction

Do not skip the required reading. A rig architect who doesn't know the spec format will produce specs that don't validate. An architect who doesn't know the startup layering model will produce agents that boot without knowing their role. An architect who doesn't check for host-level doctrine will reinvent conventions the host has already established.

## The Design Process

### Step 1: Understand the User's Intent

Before touching YAML, understand what the user actually needs:

- **What is the goal?** Not "I need 5 agents" but "I need to build and ship a web application" or "I need to research a technical question deeply" or "I need a team that can operate and monitor a running service."
- **What are the workflows?** How does work flow from intent to completion? Who does what? Where are the handoffs?
- **What is the project?** What codebase, what tech stack, what domain? This shapes agent specialization and startup content.
- **What runtimes are available?** Does the user have Claude Code? Codex? Both? Runtime availability constrains topology design.
- **How autonomous should it be?** Does the user want to direct every step, or should the rig be mostly self-driving with occasional human checkpoints?

Ask clarifying questions if the intent is ambiguous. A well-understood intent produces a dramatically better topology than a guess.

### Step 2: Identify Bounded Contexts → Pods

Every rig is organized into pods — bounded context groups where members share a workflow concern. The question is: what are the natural groupings?

**Common pod patterns:**

| Pod | Purpose | When to use |
|-----|---------|-------------|
| Orchestration | Coordination, dispatch, monitoring | Almost always — any rig with 3+ agents needs an orchestrator |
| Development | Implementation, testing, quality | Any rig that writes code |
| Review | Independent code review, architecture review | When quality gates matter (production code, security-sensitive work) |
| Research | Deep investigation, analysis, synthesis | When the work requires research before implementation |
| Design | UX, interaction design, product decisions | When the work has a user-facing interface |
| Specialist | Domain-specific operations (Vault, DB, infra) | When a specific technology needs dedicated expertise |

**Sizing principles:**

- **Solo agent:** Only when the task is genuinely single-person (quick script, simple question). No rig needed.
- **Pair (2 agents):** The minimum effective unit for quality work. One does, one verifies. The `implementation-pair` pattern.
- **Small team (3-5 agents):** Orchestrator + one or two working pods. Good starting point for focused projects.
- **Full team (6-10 agents):** Multiple bounded contexts with orchestration, development, review, and potentially research or design.
- **Large team (10-40+ agents):** Complex projects with many concerns. Include pods for development, review, research, documentation, release management, strategy, and any other bounded context the project needs.

**Important:** Agents do NOT all need to be busy at the same time. A rig is a network, not an assembly line. Some pods will be highly active (dev, review) while others are available on-demand (research, documentation, release management). An idle agent has near-zero cost but is immediately available when any other agent in the rig needs it — for quick questions, lookups, delegation, or specialized work. Design for availability, not constant utilization.

**Start small to increase the likelihood of success,** not because large rigs are wasteful. A 3-agent rig that boots and works correctly validates your spec authoring before you scale to 20 agents. Once the core topology works, expand with additional pods as needed.

### Step 3: Design Agent Roles → Members

Each pod member needs a clear role. The role determines:
- What agent spec to reference (builtin or custom)
- What profile to use
- What guidance and startup content to provide

**Builtin agents shipped with OpenRig:**

| Agent | agent_ref (in shipped starters) | Purpose |
|-------|-------------------------------|---------|
| orchestrator | `local:agents/orchestration/orchestrator` | Rig orchestration lead |
| implementer | `local:agents/development/implementer` | TDD implementation agent |
| qa | `local:agents/development/qa` | Quality assurance agent |
| reviewer | `local:agents/review/reviewer` | Independent code reviewer |
| design | `local:agents/design` | Product designer |
| vault-specialist | `local:agents/apps/vault-specialist` | Vault domain specialist |

**Path resolution:** The `local:` prefix means relative to the rig spec file's directory. In shipped starters, these paths resolve against the builtin specs directory inside the OpenRig installation. When authoring a custom rig spec outside the installation, you have two options:
- **Reference your own agent specs** with `local:` paths relative to your rig spec file
- **Use `path:` with an absolute path** to reference builtins inside the OpenRig installation (look under the `specs/agents/` directory near where `rig` is installed)

**When to create a custom agent spec:**
- The builtin doesn't match the role (e.g., you need a documentation specialist, a security auditor, a data scientist)
- The role needs domain-specific skills that no builtin carries
- The role needs custom guidance that goes beyond what startup files can provide

**When to reuse a builtin:**
- The role maps cleanly to an existing builtin (most implementation, QA, review, and orchestration roles)
- You can customize behavior through startup files and culture without changing the agent spec

### Step 4: Choose Runtimes and Models

Each member needs a `runtime` and optionally a `model`.

**Runtime selection:**
- `claude-code` — Claude Code. Best for: complex reasoning, architecture, code review, orchestration. Supports `/loop` for recurring tasks, rich hooks system, MCP servers.
- `codex` — Codex. Best for: parallel work, implementation, testing. Different approval model. Less reliable for recurring tasks.
- `terminal` — Infrastructure nodes. Servers, log tails, build watchers. Not an agent — a process.

**Runtime diversity is valuable.** Using both Claude Code and Codex in the same rig gives you different reasoning perspectives. The `product-team` starter uses Claude Code for the lead/impl/design/r1 roles and Codex for peer/qa/r2 roles. This is deliberate — model diversity catches different classes of issues.

**Model selection** is optional. The runtime's default model is usually fine. Override only when you have a specific reason (e.g., a complex architecture agent might benefit from a specific model).

### Step 5: Design Edge Topology

Edges define relationships between members. See `~/.openrig/reference/edge-types.md` for the full reference.

**Practical rules:**
- Every working pod should have at least one `delegates_to` edge from the orchestrator
- Review pods should have `can_observe` edges to the pods they review
- Within a pod, the primary workflow direction should be expressed as `delegates_to` (e.g., impl → qa)
- `delegates_to` and `spawned_by` affect launch order. Use them for dependency chains.
- `can_observe`, `collaborates_with`, `escalates_to` are informational — they help agents understand the topology but don't constrain launch.

**Start simple.** You can always add edges later. A rig with only `delegates_to` edges from the orchestrator to working pods is perfectly functional.

### Step 6: Design Startup Content Strategy

This is where most rigs succeed or fail. The topology is mechanical; the startup content is what makes agents actually useful. See `~/.openrig/reference/agent-startup-guide.md` for the full guide.

**Minimum for every rig:**
1. Each agent has a `guidance/role.md` — who they are, what they do
2. The rig has a `CULTURE.md` — how the team works together
3. Each agent gets `openrig-user` skill — so they know how to use the rig primitives

**For serious rigs, also include:**
4. `startup/context.md` per agent — boot-time grounding (project info, environment details)
5. Pod SOP skills — how each pod operates (implementation-pair SOP, review-pair SOP, etc.)
6. Project-specific documentation in rig-level startup files

**The key principle:** An agent that boots without knowing its role, its team's culture, and its project context will produce generic, unhelpful work. The startup content IS the product value. Invest in it.

### Step 7: Services Integration (If Needed)

If the rig needs managed software (databases, API servers, etc.), add a `services` block. See `~/.openrig/reference/rig-spec.md` for the full services reference.

**When to add services:**
- The agents operate ON software (not just write code)
- The project needs a local dev environment (Postgres, Redis, etc.)
- You're building a managed-app rig (software + specialist agent)

**Services boot before agents.** If health checks fail, no agents start. This is the hard gate — the environment must be healthy before agents can work.

## Authoring: The File Creation Workflow

### Directory Layout

```
my-rig/
  rig.yaml                    # The RigSpec — required
  culture/
    CULTURE.md                # Rig-wide culture — strongly recommended
  agents/
    my-custom-agent/
      agent.yaml              # AgentSpec — if custom agent needed
      guidance/
        role.md               # Role guidance
      startup/
        context.md            # Boot-time context
      skills/
        my-skill/
          SKILL.md            # Custom skill if needed
  docker-compose.yaml         # Only if services block is used
```

For rigs that reuse builtin agents, the agents directory is often unnecessary — the rig spec references the builtins directly.

### Workflow

1. **Write the rig spec** (`rig.yaml`) — define pods, members, edges, optionally services
2. **Write or reference agent specs** — builtins for standard roles, custom for specialized roles
3. **Write CULTURE.md** — the team operating manual
4. **Write role guidance** for each custom agent — who they are, what they do
5. **Write startup context** for agents that need environment grounding
6. **Validate:** `rig spec validate rig.yaml` and `rig agent validate agents/*/agent.yaml`
7. **Launch:** `rig up rig.yaml --cwd /path/to/project`
8. **Verify:** `rig ps --nodes` — all agents ready? Check `rig capture` on each agent.

### Validation Is Non-Negotiable

Always validate before launching:

```bash
rig spec validate rig.yaml
rig agent validate agents/my-agent/agent.yaml
```

If validation fails, fix the errors. Do not try to launch an invalid spec — it will fail with a less helpful error.

## Diagnosis: When Things Go Wrong

### Agent doesn't know its role

**Symptom:** Agent produces generic output, doesn't follow team conventions.
**Root cause:** Missing or insufficient `guidance/role.md`.
**Fix:** Write a clear role guidance file. Include responsibilities, working rhythm, and principles. Reference it in both `resources.guidance` and `startup.files`.

### Agent can't coordinate with peers

**Symptom:** Agent tries raw tmux commands instead of `rig send`, doesn't know peer session names.
**Root cause:** Agent didn't receive `openrig-user` skill or `openrig-start` overlay.
**Fix:** Ensure the agent's profile `uses.skills` includes `openrig-user`. Verify via `rig ps --nodes` that the agent shows the correct skills count.

### Agent hits approval prompts on rig commands

**Symptom:** Agent stalls on `rig whoami`, `rig send`, etc.
**Root cause:** Claude Code permissions not configured for rig commands.
**Fix:** Describe the required permissions in startup context. The agent should configure `~/.claude/settings.json` with allowlisted rig commands. See `~/.openrig/reference/agent-startup-guide.md` for the current support matrix.

### Agents idle — topology doesn't engage the team

**Symptom:** Orchestrator works with one or two agents, others sit idle.
**Root cause:** Missing `CULTURE.md` or pod SOP content that describes how the full team coordinates.
**Fix:** Write a culture file that explicitly describes the coordination protocol. Include delegation patterns, review gates, and when each pod should be engaged.

### Services don't boot

**Symptom:** `rig up` fails before agents launch with a service health error.
**Root cause:** Docker Compose issue, health check failure, or port conflict.
**Fix:** Check `docker compose up` manually with the compose file. Verify health check URLs are correct. Check for port conflicts.

### Startup content not delivered

**Symptom:** Agent is missing expected guidance/skills.
**Root cause:** File paths in the spec don't resolve, or `delivery_hint` is wrong.
**Fix:** Verify file paths are relative to the agent spec directory. Check `delivery_hint` — use `guidance_merge` for pre-boot content, `send_text` for post-boot instructions.

### Agent startup delivered but agent doesn't use skills

**Symptom:** Skills are projected but agent doesn't invoke them.
**Root cause:** Agent wasn't told to load them.
**Fix:** In the startup context or role guidance, explicitly tell the agent which skills to load. The belt-and-suspenders pattern: project the skills via the spec AND tell the agent to read them in the guidance.

## Pattern Catalog

### The Implementation Pair
**2 agents, 1 pod.** The smallest effective development unit. One implements (TDD), one does QA. The implementer proposes, QA approves or rejects, then the implementer commits.

```yaml
pods:
  - id: dev
    label: Development
    members:
      - id: impl
        agent_ref: "local:agents/development/implementer"
        runtime: claude-code
        profile: default
        cwd: "."
      - id: qa
        agent_ref: "local:agents/development/qa"
        runtime: codex
        profile: default
        cwd: "."
    edges:
      - kind: delegates_to
        from: impl
        to: qa
```

**Use when:** Focused feature work, bug fixes, small-to-medium implementation tasks.

### The Orchestrated Team
**5-7 agents, 3 pods.** Orchestration + development + review. The orchestrator dispatches work, the dev pair implements, the review pair validates independently.

**Use when:** Production-quality work that needs coordination and independent review.

### The Research Team
**3 agents, 2 pods.** Orchestrator + research pair (analyst + synthesizer). The analyst investigates deeply, the synthesizer consolidates findings.

**Use when:** Technical research, competitive analysis, architecture exploration.

### The Managed App
**1+ agents, 1 pod, services block.** Software infrastructure (Docker Compose) plus a specialist agent who knows how to operate it.

```yaml
services:
  kind: compose
  compose_file: docker-compose.yaml
  wait_for:
    - url: http://127.0.0.1:8200/v1/sys/health

pods:
  - id: vault
    label: Vault
    members:
      - id: specialist
        agent_ref: "local:agents/apps/vault-specialist"
        runtime: claude-code
        profile: default
        cwd: "."
    edges: []
```

**Use when:** The work involves operating software, not just writing code.

### The Full Product Team
**7 agents, 3 pods.** The kitchen-sink topology: orchestration pair, development pod (impl + qa + design), review pair. See the `product-team` starter spec for the complete worked example.

**Use when:** Full product development with design, implementation, QA, and independent review. Requires strong culture and SOP content to keep all agents engaged.

## Final Notes

**Start simple, add complexity when needed.** A working implementation pair is better than a broken full team. Launch with the minimum viable topology, verify it works, then expand.

**Culture is not optional for team rigs.** Any rig with 3+ agents needs a CULTURE.md. Without it, agents will default to generic behavior and the topology will underperform.

**Validate early and often.** Run `rig spec validate` after every change. Run `rig agent validate` after every agent spec edit. Fix errors immediately — don't accumulate them.

**The startup content IS the product.** The YAML topology is scaffolding. What makes a rig actually useful is the guidance, culture, skills, and startup context that agents receive. Invest your authoring time there.
