# Agent Startup Guide

Version: 0.2.0
Last validated: 2026-04-11
Applies to: OpenRig 0.1.x

This guide teaches you how to think about what goes into an agent's startup experience — what files to write, where to put them, and how the layering model delivers them. It is an authoring guide, not a schema reference. For field-level details, see `rig-spec.md` and `agent-spec.md`.

---

## Two Categories of Startup

Everything an agent receives at boot time falls into one of two categories:

### Category 1: Context Loading

The agent reads markdown files into its context window. This is the **primary mechanism** in OpenRig today and the one you should invest most of your authoring effort in.

Context loading shapes what the agent knows, believes, and is capable of:
- Who it is (role, identity, pod membership)
- How the team works (culture, communication norms, coordination protocols)
- What the project is (codebase context, architecture, domain knowledge)
- What it can do (skills, SOPs, operational procedures)
- What its environment looks like (services, access credentials, tools)

### Category 2: Deterministic Configuration

The rig spec declaratively installs things into the agent's runtime environment:
- Hooks (git hooks, pre-commit scripts)
- Permissions (`.claude/settings.json` allowlists, approval modes)
- MCPs (Model Context Protocol servers)
- System dependencies (tools, packages)

See the **Current Support Matrix** section at the end of this guide for what is reliable today vs experimental.

**The v0.2.0 recommendation:** Put as much of your setup logic as possible into Category 1 (context loading via markdown files). Describe the desired end state in startup files and let the agent handle the configuration. The deterministic path exists in the spec and will become more reliable over time, but for now the context-loading path is the one that works consistently across runtimes.

---

## Context Loading: What Goes Where

### Skills vs Startup Files — The Key Distinction

**Skills** are reusable SOPs. They teach an agent HOW to do something — how to use OpenRig, how to do TDD, how to run a code review, how to operate Vault. Skills transfer across rigs. A skill you write once can be used by any agent in any rig.

**Startup/guidance files** are rig-specific and role-specific. They tell an agent WHO it is, WHAT it's working on, and HOW this particular team operates. They are authored per-rig and often per-pod or per-member.

| Put in a skill when... | Put in a startup/guidance file when... |
|------------------------|---------------------------------------|
| The knowledge is reusable across rigs | The knowledge is specific to this rig or project |
| It teaches a procedure or methodology | It teaches identity, role, or team context |
| It could be useful to any agent of this type | It's only useful to agents in this specific topology |
| Examples: `openrig-user`, `test-driven-development`, `vault-user` | Examples: `role.md`, `CULTURE.md`, `startup/context.md` |

### The Belt-and-Suspenders Pattern for Skills

Skills are delivered to agents through two parallel paths:

1. **Spec declaration:** The agent spec's `resources.skills` + profile `uses.skills` ensures the skill files are projected to the agent's workspace (installed before harness boot)
2. **Startup instruction:** The guidance/startup files tell the agent to actually read and load those skills

Both paths are important. The spec projection ensures the files are physically present. The startup instruction ensures the agent knows to read them. This redundancy is intentional — it handles cases where one path fails.

Example: An implementer agent's startup guidance says "Load the following skills: openrig-user, test-driven-development, mental-model-ha" — AND the agent spec's profile uses those same skill IDs. The agent gets the files from projection and the instruction to read them from guidance.

### The File Types

**Role guidance (`guidance/role.md`)**

Tells the agent who it is and what its responsibilities are:
- Title and primary function
- Specific responsibilities (bulleted list)
- Working rhythm (how the agent operates day-to-day)
- Principles (behavioral guidelines)
- Relationship to other team members

This is the agent's identity document. Every agent should have one.

**Rig culture (`CULTURE.md`)**

The rig-wide constitution. Applied to ALL agents in the rig:
- Communication norms (use `rig send`/chatroom, not raw tmux)
- Coordination protocol (how work flows between pods)
- Quality standards (what "done" means)
- Commit/merge policy
- Escalation rules

Think of this as the team operating manual that every team member reads on day one.

**Startup context (`startup/context.md`)**

Boot-time grounding information specific to this agent's operating environment:
- Identity recovery instructions (`rig whoami --json`)
- Environment details (service URLs, access credentials, ports)
- System check instructions (what should be running, how to verify)
- Role-specific delegation information (who to ask, who delegates to you)

This is especially important for managed-app specialists (e.g., a Vault specialist needs to know the Vault address and dev token).

**Project documentation**

Rig-level startup files that teach the agent about the project:
- Architecture overview
- Key conventions
- Domain vocabulary
- Recent context (what's been happening, what's in progress)

These go in rig-level or pod-level startup blocks and are delivered to relevant agents.

---

## The Layering Model

Startup content is merged additively through layers. Each layer adds to what the previous layers provided. Later layers do NOT replace earlier layers — they append.

### The Layers (in delivery order)

```
1. Agent layer     — from the AgentSpec's top-level startup block
2. Profile layer   — from the active profile's startup block
3. Rig layer       — from the RigSpec's top-level startup block
4. Culture layer   — from the RigSpec's culture_file
5. Pod layer       — from the pod's startup block
6. Member layer    — from the member's startup block in the RigSpec
7. Operator layer  — injected at runtime (openrig-start overlay, context collector, etc.)
```

### What Each Layer Is For

| Layer | Authored by | Purpose | Example content |
|-------|-------------|---------|-----------------|
| Agent | Agent spec author | Core identity and capabilities that travel with this agent type | Role guidance, default skills |
| Profile | Agent spec author | Profile-specific variations | Different skill sets for "default" vs "minimal" profiles |
| Rig | Rig spec author | Rig-wide context for all agents | Team norms, project documentation |
| Culture | Rig spec author | Rig constitution | `CULTURE.md` — communication, quality, operating philosophy |
| Pod | Rig spec author | Pod-specific coordination context | Pod SOP, intra-pod workflow |
| Member | Rig spec author | Individual member overrides | Member-specific instructions, cwd-specific context |
| Operator | OpenRig system | System-injected runtime content | `openrig-start.md`, context collector |

### Practical Guidance

**Most rigs only need three layers:** agent (role.md), rig (culture), and operator (openrig-start). Start simple. Add pod and member layers only when agents in the same pod need different startup content.

**The culture layer is high-value and often skipped.** A rig without a `CULTURE.md` relies on agents to guess how the team communicates and coordinates. Write one. Even a short culture file dramatically improves team coherence.

**Member-level startup is for exceptions, not the rule.** If every member has its own startup block, the layering model is being used as a configuration dump. Refactor shared content up to the pod or rig level.

---

## Delivery Mechanisms

### How Files Reach the Agent

| Delivery Hint | When | How | Use For |
|---------------|------|-----|---------|
| `auto` | Before harness boot | System chooses | Default — let OpenRig decide |
| `guidance_merge` | Before harness boot | Merged into `CLAUDE.md` / `AGENTS.md` as a managed block | Role guidance, culture, project context |
| `skill_install` | Before harness boot | Copied to runtime's skill directory | Skills |
| `send_text` | After harness is ready | Sent as text to agent's terminal via tmux | Boot-time grounding, identity hints, instructions to read skills |

### Delivery Timing Matters

Files delivered via `guidance_merge` and `skill_install` happen BEFORE the agent's harness boots. The agent sees them immediately when it starts — they're part of the initial context.

Files delivered via `send_text` happen AFTER the harness is ready. The agent receives them as messages in its terminal. Use this for:
- Identity grounding (agent reads and processes the instructions)
- Instructions to load skills (the files are already projected, the message tells the agent to read them)
- Context that should feel like an operator briefing, not pre-loaded content

### The `applies_on` Field

Each startup file and action specifies when it applies:
- `fresh_start` — delivered on first launch only
- `restore` — delivered on restore from snapshot
- Default: `[fresh_start, restore]` (both)

Use this to avoid re-sending context that the agent already has from its resumed conversation. For example, a one-time project briefing might only apply on `fresh_start`, while identity grounding should apply on both.

---

## Deterministic Configuration

The AgentSpec and RigSpec allow declaring deterministic environment configuration:

### What the Spec Supports

**Hooks** (in `resources.hooks`):
```yaml
resources:
  hooks:
    - id: pre-commit
      path: hooks/pre-commit.sh
      runtimes: [claude-code]
```
Hooks are scripts copied to the agent's workspace. They can be git hooks, automation scripts, or environment setup.

**Runtime resources** (in `resources.runtime_resources`):
```yaml
resources:
  runtime_resources:
    - id: claude-settings
      path: runtime/claude-settings.json
      runtime: claude-code
      type: settings
```
Runtime-specific configuration files projected into the agent's runtime environment.

**Startup actions** (in `startup.actions`):
```yaml
startup:
  actions:
    - type: send_text
      value: "/install-mcp my-server"
      phase: after_ready
      idempotent: true
```
Commands sent to the agent's terminal after it's ready. Can install MCPs, run setup commands, etc.

### Current Support Matrix (OpenRig 0.1.x)

| Capability | Status | Notes |
|------------|--------|-------|
| Guidance file projection (`guidance_merge`) | **Supported** | Reliable. Primary delivery mechanism. |
| Skill projection (`skill_install`) | **Supported** | Reliable. Skills are copied to workspace. |
| `send_text` delivery after ready | **Supported** | Reliable. Requires harness to be ready. |
| Hook projection | **Experimental** | Files are copied but execution/integration varies by runtime. |
| Runtime resource projection | **Experimental** | Files are projected but runtime-specific handling is not guaranteed. |
| Permission allowlisting | **Supported (manual)** | Works via `~/.claude/settings.json` or Codex launch flags. OpenRig can describe the desired state; agent self-configures. |
| MCP installation | **Experimental** | Claude Code: `/mcp` interactive command or `claude mcp add` from CLI. Can also be described in startup files for agent self-configuration. Reliability depends on runtime TUI state. |
| System dependency installation | **Not deterministic** | Describe in startup files; agent handles via shell commands. |
| Recurring tasks / wake timers | **Runtime-dependent** | Claude Code supports recurring tasks via the `/loop` command. Codex does not have a confirmed equivalent. Orchestrators should include `/loop` instructions in startup for Claude Code agents. |

### The v0.2.0 Approach: Describe, Then Let the Agent Handle It

For anything beyond `guidance_merge`, `skill_install`, and `send_text`, the recommended approach is:

1. **Describe the desired end state** in a startup file (e.g., "You need these MCP servers configured, these permissions set, these hooks installed")
2. **Include a system check** in the startup instructions ("Verify your environment: check that X is installed, Y is configured, Z is accessible")
3. **Empower the agent to self-configure** ("If any of these are missing, install/configure them")
4. **Optionally also declare it in the spec** for when deterministic support improves — the spec serves as the blueprint, and the startup file serves as the fallback instruction

This way, when deterministic support becomes fully reliable, the agent will boot up, see that everything is already set up (by the deterministic path), run its system check, confirm everything looks good, and proceed. Until then, the agent reads the instructions and handles the setup itself.

### Runtime Config Disclosure

OpenRig now performs some best-effort deterministic runtime configuration for managed sessions. These writes are intentionally invasive and should be disclosed plainly:

- Claude global config: `~/.claude/settings.json`
  Purpose: allow `rig` commands without repeated Claude permission prompts.
- Claude global state: `~/.claude.json`
  Purpose: pre-trust managed workspaces and mark onboarding complete for fresh managed sessions.
- Claude project-local config: `.claude/settings.local.json`
  Purpose: apply managed-session Claude permissions inside the project without committing them to git.
- Claude project-local MCP config: `.mcp.json`
  Purpose: configure OpenRig-managed MCP servers for Claude in that project.
- Codex global config: `~/.codex/config.toml`
  Purpose: pre-trust managed workspaces and configure Codex MCP servers. Codex currently has no equivalent project-local MCP config path.

Two important caveats:
- these writes are best-effort and should still be paired with startup guidance so the local agent can verify and repair them if needed
- already-running adopted sessions may need restart before they pick up newly written config

### Runtime Differences

**Claude Code:**
- Reads from `CLAUDE.md` and `.claude/` directory
- Recurring tasks via the `/loop` command (e.g., `/loop 5m "check rig health"`) — this is NOT hooks; hooks are event-driven
- MCP server management via `/mcp` interactive command or `claude mcp add` from CLI
- Event-driven hooks system in `.claude/settings.json` — reacts to events like `PreToolUse`, `PostToolUse`, `SessionStart`, etc. (not time-based)
- Permission allowlisting via `.claude/settings.json` (`permissions.allow`, `permissions.deny`, `permissions.defaultMode`)
- Can self-configure MCP servers, permissions, and hooks from startup instructions

**Codex:**
- Reads from `AGENTS.md` and `.agents/` directory
- Recurring task support is limited — no confirmed equivalent of Claude Code's `/loop` command
- MCP configuration mechanism differs from Claude Code
- Approval mode controlled via launch flags (`-a`, `-s`, `--full-auto`)
- Can self-install dependencies from instructions but timer/recurring behavior is not reliably available

When authoring startup content, note which instructions are runtime-specific. For example, an orchestrator that needs a monitoring loop should include instructions like: "If running Claude Code, use `/loop 3m` to periodically check rig health. If running Codex, check rig health at the start of each task cycle instead."

---

## Patterns and Anti-Patterns

### Good Patterns

**Start with role + culture + one skill**
```
agent.yaml → guidance/role.md
rig.yaml → culture_file: CULTURE.md
profile → uses.skills: [openrig-user]
```
This is the minimum effective startup. The agent knows who it is, how the team works, and how to use the rig.

**Separate project context from role**

Don't put project documentation inside the role guidance. The role is about the agent's function; project context is about what the agent is working on. Use rig-level or pod-level startup files for project context.

**Tell the agent about its skills explicitly**

In a startup file or guidance, include a line like:
```
You have the following skills loaded: openrig-user, test-driven-development, mental-model-ha. Use them.
```
This prompts the agent to actually invoke the skills, not just have them as passive context.

**Include a system check in startup context**

```
## System Check

After identity recovery, verify:
1. `rig ps --nodes` shows your rig running
2. `rig env status` shows services healthy (if applicable)
3. Your working directory is correct
4. Required tools are available (node, npm, git, etc.)

If anything is missing, fix it before starting work.
```

### Anti-Patterns

**Dumping everything into one giant CLAUDE.md**

Don't. Use the layering model. Role goes in the agent spec. Culture goes in the rig spec. Project context goes in rig/pod startup files. If everything is in one file, you can't reuse any of it.

**Duplicating skill content in guidance files**

If you find yourself copying text from a skill into a guidance file, stop. Reference the skill instead. Skills are projected; guidance should point to them, not duplicate them.

**Using send_text for content that should be pre-loaded**

If the agent needs to know something BEFORE it starts reasoning, use `guidance_merge` (delivered before boot), not `send_text` (delivered after boot). `send_text` is for instructions the agent should process as a first task, not for foundational context.

**Over-specifying member-level startup**

If every member has a large startup block, the rig spec becomes a configuration dump. Refactor shared content up to the pod level. Member-level startup should be small overrides, not complete agent briefings.

**Relying on deterministic hooks for critical setup**

If your rig REQUIRES a hook to function and the hook installation fails silently, the agent won't know something is wrong. Always pair deterministic config with a startup instruction or system check that verifies the result.

---

## Authoring Checklist

When creating a new agent's startup experience:

- [ ] Write a `guidance/role.md` — who is this agent?
- [ ] Reference it in the agent spec's `resources.guidance` AND `startup.files`
- [ ] Write a rig `CULTURE.md` if the rig doesn't have one
- [ ] Choose skills from the shared pool via profile `uses`
- [ ] Write a `startup/context.md` if the agent needs environment grounding
- [ ] Include a system check in the startup context
- [ ] Verify the agent spec validates: `rig agent validate agent.yaml`
- [ ] Verify the rig spec validates: `rig spec validate rig.yaml`
- [ ] Test by launching the rig and checking that the agent received the expected content
