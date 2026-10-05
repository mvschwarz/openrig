# Agent Startup Guide

Last validated: 2026-10-05, against main `9b88b118`
Applies to: OpenRig 0.6.6

This guide teaches you how to think about what goes into an agent's startup experience — what files to write, where to put them, and how the layering model delivers them. It is an authoring guide, not a schema reference. For field-level details, see `rig-spec.md` and `agent-spec.md`.

---

## Continue after a native consent prompt

If a fresh Claude seat is waiting at its bypass-permissions warning, review and
answer that warning in the seat's native pane. Unless the rig was launched with
`--non-interruptive` (see [non-interruptive mode](non-interruptive-mode.md)),
OpenRig does not accept it for you, and it never sends configured startup context
into the active dialog. The seat reports `attention_required` and retains that
context for the same occupant.

After accepting, run `rig seat continue <seat>` (or press `c` on the seat in the
TUI, shown while its context is pending). This delivers the pending context
without relaunching Claude, and its first prompt reminds the seat that this is a
fresh conversation and how to find its work. It does not replay a delivery that
already started. A timeout, or a refusal because nothing is pending, reports an
unknown outcome; inspect `rig seat status <seat>` before taking another action.
It is also refused while the prompt is still showing (`attention_required`), or
when the seat's binding or runtime has changed since launch.
Runtime readiness, startup delivery, and orientation proof remain separate;
a missing proof does not block this continuation.

Other fresh-launch prerequisites, such as login or workspace trust, use the same
continuation: resolve the prerequisite in the native pane, then run the displayed
command. `rig ps --nodes` shows it under "Startup details (<seat>)", and
`rig up` and `rig bundle install` print it as "Startup attention (<seat>)":
"After resolving it in <session>, run: rig seat continue <session>".

The attention codes that stop startup this way are `trust_gate`,
`hook_trust_gate`, `update_gate`, `login_required`, `mcp_gate`,
`bypass_consent_gate`, `codex_auth_refusal` and `codex_client_incompatible`.
They are recognized from each harness's English prompt text.

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
- Hooks (shipped inside plugins)
- Permissions (`.claude/settings.json` allowlists, approval modes)
- MCPs (Model Context Protocol servers)
- System dependencies (tools, packages)

See the **Current Support Matrix** section at the end of this guide for what is reliable today vs experimental.

**The recommendation:** Put as much of your setup logic as possible into Category 1 (context loading via markdown files). Describe the desired end state in startup files and let the agent handle the configuration. The deterministic path exists in the spec and will become more reliable over time, but for now the context-loading path is the one that works consistently across runtimes.

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

Example: An implementer agent's startup guidance says "Load the following skills: openrig-user, test-driven-development, systematic-debugging" — AND the agent spec's profile uses those same skill IDs. The agent gets the files from projection and the instruction to read them from guidance.

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
3. Culture layer   — OpenRig's default culture, then the RigSpec's culture_file
4. Rig layer       — from the RigSpec's top-level startup block
5. Pod layer       — from the pod's startup block
6. Member layer    — from the member's startup block in the RigSpec
7. Operator layer  — added by OpenRig: openrig-start.md and, on a fresh start, the onboarding pack
```

A member with a `starter_ref` gets that agent starter's files in front of the agent layer. Terminal seats
(`builtin:terminal`) skip the agent and profile layers.

### What Each Layer Is For

| Layer | Authored by | Purpose | Example content |
|-------|-------------|---------|-----------------|
| Agent | Agent spec author | Core identity and capabilities that travel with this agent type | Role guidance, default skills |
| Profile | Agent spec author | Profile-specific variations | Different skill sets for "default" vs "minimal" profiles |
| Culture | OpenRig, then the rig spec author | Team norms | OpenRig's `CULTURE-default.md` for every seat, then the rig's own `CULTURE.md` |
| Rig | Rig spec author | Rig-wide context for all agents | Project documentation |
| Pod | Rig spec author | Pod-specific coordination context | Pod SOP, intra-pod workflow |
| Member | Rig spec author | Individual member overrides | Member-specific instructions, cwd-specific context |
| Operator | OpenRig system | System-injected runtime content | `openrig-start.md` (optional delivery); on a fresh start, `openrig-onboarding-01.md` and `-02.md` unless `onboarding.default_pack.enabled` is false |

After the files, OpenRig sends a session-identity message (rig, pod, member, logical ID) once the seat is ready.

### Practical Guidance

**Most rigs only need three layers:** agent (role.md), culture, and the built-in operator layer. Start simple. Add pod and member layers only when agents in the same pod need different startup content.

**The rig's own culture file is high-value and often skipped.** Every seat gets OpenRig's default culture, but that says nothing about how this team communicates and coordinates. Write a `CULTURE.md`. Even a short one dramatically improves team coherence.

**Member-level startup is for exceptions, not the rule.** If every member has its own startup block, the layering model is being used as a configuration dump. Refactor shared content up to the pod or rig level.

---

## Delivery Mechanisms

### How Files Reach the Agent

| Delivery Hint | When | How | Use For |
|---------------|------|-----|---------|
| `auto` | Depends on the file | Resolved per file: a `SKILL.md` (or content starting `# SKILL`) is `skill_install`, any other `.md` is `guidance_merge`, and any other file is `send_text` | Default — let OpenRig decide |
| `guidance_merge` | Before harness boot | Merged as a managed block into `AGENTS.md` (Codex, Pi) or `CLAUDE.md` (Claude; `CLAUDE.local.md` with the rig's `managed_blocks: { claude-code: CLAUDE.local.md }`) | Role guidance, culture, project context |
| `skill_install` | Before harness boot | Copied to runtime's skill directory | Skills |
| `send_text` | After harness is ready | Sent as text to agent's terminal via tmux | Boot-time grounding, identity hints, instructions to read skills |

### Delivery Timing Matters

Files delivered via `guidance_merge` and `skill_install` happen BEFORE the agent's harness boots. The agent sees them immediately when it starts — they're part of the initial context.

Files delivered via `send_text` happen AFTER the harness is ready. The agent receives them as messages in its terminal. Use this for:
- Identity grounding (agent reads and processes the instructions)
- Instructions to load skills (the files are already projected, the message tells the agent to read them)
- Context that should feel like an operator briefing, not pre-loaded content

On a fresh launch the first message is one turn: the session identity, the first `send_text` file and, when a startup
proof is selected, its challenge (below).

A file's `required` field defaults to `true`: a required file that can't be delivered fails startup, and an optional
one is dropped without a message.

### Readiness, startup proof and failure

**Readiness.** After launch OpenRig polls the pane until the harness is interactive (backing off 1, 2, 4, 8 and 16
seconds), for up to 30 seconds by default. Change the window with
`rig config set runtime.readiness_timeout_seconds <1-600>` (or `OPENRIG_RUNTIME_READINESS_TIMEOUT_SECONDS`); it
applies to the next launch. A recognized prompt (the attention codes above) ends the wait at once as
`attention_required`. A timeout ends startup as `failed` ("Readiness timeout after Ns — harness did not become
interactive"), and the post-launch files aren't sent.

**Claude submission check.** For each startup message to a Claude seat, OpenRig makes a bounded check that the prompt
was submitted. When the capture can't tell, it records the submission as unverified and carries on. When it sees the
same prompt still sitting in the input, it presses Enter once more; if it's still there, it warns "Startup prompt still
staged in <session>; press Enter in that pane." The seat can still end `ready` with its submission `unverified` or
`staged`, so `ready` doesn't prove the prompt was submitted. After all files and actions are delivered, readiness is
checked once more, so a prompt that appears by then gives `attention_required`.

**Startup proof.** A `startup_proof` action selects `authenticated` or `none` (the default is none; the last applicable
one wins, and it needs `idempotent: true`). With `authenticated`, a fresh launch of an agent seat includes a challenge,
and the seat answers it with `rig startup-proof submit --challenge-id <id> --answer <answer>`. `rig ps --nodes --full`
shows the result in the ORIENTED column: `verified`, `missing`, `rejected` or `n-a`. A missing proof doesn't block startup.

**After a failure.** Delivery, launch and action failures, and readiness timeouts, give `failed`. Every 30 seconds the
context monitor marks a `failed` or `attention_required` seat `ready` once its pane reads ready, unless fresh context
is still pending for `rig seat continue`. A seat that timed out can therefore read `ready` without having received its
post-launch files. If it needs them, first look at what that occupant has done; then
`rig seat launch <seat> --fresh --reason <text>` starts a blank conversation for the seat. If the occupant is still
live, the command refuses with `session_live` unless you also pass `--stop`, which replaces that occupant deliberately.

### The `applies_on` Field

Each startup file and action specifies when it applies:
- `fresh_start` — delivered when a new conversation starts: the first launch, `rig seat launch --fresh`,
  `rig seat continue`, and seats restored with `--fresh`
- `restore` — delivered when a seat is restored, including a restore whose resume falls back to a fresh conversation
- Default: `[fresh_start, restore]` (both)

Use this to avoid re-sending context that the agent already has from its resumed conversation. For example, a one-time project briefing might only apply on `fresh_start`, while identity grounding should apply on both.

---

## Deterministic Configuration

The AgentSpec and RigSpec allow declaring deterministic environment configuration:

### What the Spec Supports

**Hooks** ship inside plugins: declare the plugin under `resources.plugins[]`. AgentSpec validation refuses
`resources.hooks`.

**Runtime resources** (in `resources.runtime_resources`):
```yaml
resources:
  runtime_resources:
    - id: claude-settings
      path: runtime/claude-settings.fragment.json
      runtime: claude-code
      type: claude_settings_fragment
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
Each value is typed into the harness's input and submitted, so it is a prompt or a slash command, not a shell command.
Types are `send_text`, `slash_command` and `startup_proof` (see "Startup proof" above); `shell` is refused.
`idempotent` is required, and an action that isn't idempotent must not list `restore` in `applies_on`. Both phases
run after the harness is ready: `after_files` (the default) after the post-launch files, then `after_ready`.

### Current Support Matrix

| Capability | Status | Notes |
|------------|--------|-------|
| Guidance file projection (`guidance_merge`) | **Supported** | Reliable. Primary delivery mechanism. |
| Skill projection (`skill_install`) | **Supported** | Reliable. Skills are copied to workspace. |
| `send_text` delivery after ready | **Supported** | Reliable. Requires harness to be ready. |
| Hooks | **Through plugins** | Declare a plugin under `resources.plugins[]`; `resources.hooks` is refused. |
| Runtime resource projection | **Supported for recognized fragments** | `claude_settings_fragment`, `claude_mcp_fragment`, and `codex_config_fragment` are applied to provider config. Unknown types are copied to runtime extension directories. |
| Permission configuration | **Native settings plus managed launch flags** | OpenRig launches Claude with `acceptEdits` and Codex with `workspace-write` unless an explicit supported selection changes them; the `kernel` rig's seats get a wider operational default ([rig spec, "At launch"](rig-spec.md)). It does not add a global Claude `Bash(rig:*)` allowance. Use [the first-user permission guide](getting-started.md#opt-in-permissive-operation) for opt-in and custom choices. |
| MCP installation | **Supported for Claude fragments** | A selected `claude_mcp_fragment` is merged into the project's `.mcp.json`. Claude asks to approve new servers found there; that prompt stops startup as `mcp_gate` until someone answers it and runs `rig seat continue`. Otherwise use `/mcp` or `claude mcp add`, or describe the servers in startup files for the agent to configure. |
| System dependency installation | **Not deterministic** | Describe in startup files; agent handles via shell commands. |
| Recurring tasks / wake timers | **Runtime-dependent** | Claude Code supports recurring tasks via the `/loop` command. Codex does not have a confirmed equivalent. Orchestrators should include `/loop` instructions in startup for Claude Code agents. |

### The Approach: Describe, Then Let the Agent Handle It

For anything beyond `guidance_merge`, `skill_install`, and `send_text`, the recommended approach is:

1. **Describe the desired end state** in a startup file (e.g., "You need these MCP servers configured, these permissions set, these hooks installed")
2. **Include a system check** in the startup instructions ("Verify your environment: check that X is installed, Y is configured, Z is accessible")
3. **Empower the agent to self-configure** ("If any of these are missing, install/configure them")
4. **Optionally also declare it in the spec** for when deterministic support improves — the spec serves as the blueprint, and the startup file serves as the fallback instruction

This way, when deterministic support becomes fully reliable, the agent will boot up, see that everything is already set up (by the deterministic path), run its system check, confirm everything looks good, and proceed. Until then, the agent reads the instructions and handles the setup itself.

### Runtime Config Disclosure

OpenRig performs best-effort deterministic runtime configuration for managed sessions. Core bootstrap stays minimal; user/custom policy belongs in spec-selected runtime resources. These writes are intentionally invasive and should be disclosed plainly:

- Claude global config: `~/.claude/settings.json`
  OpenRig no longer writes a core `Bash(rig:*)` permission allowance here. Older
  installations may retain one; existing user settings are not removed.
- Claude global state: `~/.claude.json`
  Purpose: pre-trust managed workspaces and mark onboarding complete for fresh managed sessions.
  Explicit permission modes use the launch-selected `HOME/.claude.json`, or
  `<CLAUDE_CONFIG_DIR>/.claude.json` when that variable is set. Classic startup
  retains the daemon-home path.
- Claude project-local config: `.claude/settings.local.json`
  Purpose: apply context collector/activity hooks and selected `claude_settings_fragment` resources inside the project without committing them to git.
- Claude project-local MCP config: `.mcp.json`
  Purpose: apply selected `claude_mcp_fragment` resources for Claude in that project.
- Codex global config: `$CODEX_HOME/config.toml`, or `~/.codex/config.toml` when unset
  Purpose: pre-trust managed workspaces and apply selected `codex_config_fragment` resources. Codex currently has no equivalent project-local MCP config path for global profile settings.

Two important caveats:
- these writes are best-effort and should still be paired with startup guidance so the local agent can verify and repair them if needed
- already-running adopted sessions may need restart before they pick up newly written config

Permission mode and runtime resource projection are separate. A selected fragment
can affect native configuration, but OpenRig's launch flags can override those
values. Recording a config-surface `permission_policy` is not proof that its
rules were translated or applied. See [permission precedence and limits](getting-started.md#custom-settings-and-precedence).

### Separate Codex homes for separate installations

Set an **absolute `CODEX_HOME` in the environment that starts the daemon** when
you want a separate Codex configuration and state root. OpenRig uses that root
for its startup hook setup/removal and trust records, feature flag, workspace
trust and selected config fragments. Startup can write those files even when
the daemon has no seats.

The explicit selection also applies to future managed Codex fresh, resume and
fork launches, their capability/profile/configuration probes, native thread and
context reads, and plugin-cache discovery. Launch commands reassert it after
pane shell startup, so an rc file cannot silently switch that launch to another
Codex home. Executable and PATH selection stay the same. Existing running
sessions are not moved or restarted; a thread in another home is not searched
as a fallback for an explicitly selected home.

**With `CODEX_HOME` unset, a second install still shares `~/.codex`.** Setting only
`OPENRIG_HOME` separates OpenRig state, not provider configuration. The default
launch behavior is unchanged, including existing pane-shell overrides.

OpenRig does not copy or migrate authentication, history, rules, trust or
settings into the selected home. A separate file-backed home needs its intended
authentication provisioned if absent; OS credential stores and other config
layers can behave differently, so a new login is not universally required.
Explicit Codex auth commands resolve their **caller's** `CODEX_HOME`, otherwise
`$HOME/.codex`; contacting a daemon with `OPENRIG_URL` does not retarget auth
save/switch/registry writes to that daemon's selection. Set the intended root
on those commands as well.

This separates provider files, not OS users or accounts. Project-local resources
still use the selected project directory; shared project and system settings
remain shared.

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
- Approval policy and sandbox access are separate controls. OpenRig's default
  `-s workspace-write` selects the sandbox; it does not force `-a`. A member's
  `codex_config_profile` selects native `-p`, distinct from the AgentSpec `profile`.
- On that plain `-s workspace-write` launch (fresh, resume, fork or restore), a
  short-lived `codex app-server` first reads Codex's own configuration with the
  seat's executable, home and working directory. OpenRig adds
  `-c sandbox_workspace_write.network_access=true` only when no configuration
  layer sets network access and no managed requirement could restrict it. A
  timeout, error or unrecognized answer adds nothing. Named profiles and full
  bypass are not read. The read may write Codex's own state files in
  `CODEX_HOME`, read its login and fetch managed policy, as a Codex start does.
- Can self-install dependencies from instructions but timer/recurring behavior is not reliably available

**Pi and OMP:**
- Read `AGENTS.md` in the working directory; guidance is merged there, added to Pi's own system prompt
- Selected skills are projected into the seat's own agent directory under OpenRig's state, not into a shared
  workspace folder

**Terminal seats** (`builtin:terminal`) get no agent or profile layers and no startup proof.

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

For seats sharing a working directory, keep each role in its own AgentSpec startup entry:

```yaml
startup:
  files:
    - path: guidance/role.md
      orientation: role
      delivery_hint: send_text
      required: true
```

`rig queue whoami --json` reports only the calling seat's explicitly marked role
bindings, independently of its current work. The `role.state` is `no-record`,
`not-declared`, `missing`, `present`, or `unknown` when identity, storage or the
observation is unavailable. Files retain their original `path`, `absolutePath`
and `ownerRoot` plus the currently resolved `resolvedPath` and
`resolvedOwnerRoot`. Built-in packaged paths follow the running installation;
existing development-checkout paths stay where they were recorded.

`recordedAt` is the startup-context record write/attempt, which happens before
launch succeeds. Exact resume can retain an older record. `present` means the
resolved file currently exists, not that its bytes still match the spec or that
the agent read it. Unmarked startup files and startup actions are not exposed.

Refocus includes the role path and a re-read reminder with topology or both trees,
even if the trace fails. Work-only mode omits it; disabling refocus still disables
the entire hook. Custom refocus prose keeps its existing precedence. The hook
reuses its work lookup, or makes one bounded lookup when the work node is explicit;
a failed or skipped lookup reports `unknown`.

The shipped kernel seats no longer project their role into shared guidance.
Existing user files and legacy role blocks are left intact; this is not a cleanup
of already-installed shared blocks. General user-authored guidance projection is
unchanged.

**Separate project context from role**

Don't put project documentation inside the role guidance. The role is about the agent's function; project context is about what the agent is working on. Use rig-level or pod-level startup files for project context.

**Tell the agent about its skills explicitly**

In a startup file or guidance, include a line like:
```
You have the following skills loaded: openrig-user, test-driven-development, systematic-debugging. Use them.
```
This prompts the agent to actually invoke the skills, not just have them as passive context.

**Include a system check in startup context**

```
## System Check

After identity recovery, verify:
1. `rig ps --nodes` shows your rig running (scoped to your session's rig by default; outside a managed session name it explicitly: `rig ps --nodes --rig <name>`)
2. `rig env status <rig>` shows services healthy (if applicable)
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
- [ ] Reference it in `startup.files` with `orientation: role` and `delivery_hint: send_text`. Avoid projecting distinct seat roles into one shared `AGENTS.md` or `CLAUDE.md`.
- [ ] Write a rig `CULTURE.md` if the rig doesn't have one
- [ ] Choose skills from the shared pool via profile `uses`
- [ ] Write a `startup/context.md` if the agent needs environment grounding
- [ ] Include a system check in the startup context
- [ ] Verify the agent spec validates: `rig agent validate agent.yaml`
- [ ] Verify the rig spec validates: `rig spec validate rig.yaml`
- [ ] Run the advisory authoring check: `rig spec audit rig.yaml`
- [ ] Test by launching the rig and checking that the agent received the expected content
