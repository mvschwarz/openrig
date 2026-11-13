# Agent Startup Guide

Last validated: 2026-10-05, against main `9b88b118`
Applies to: OpenRig 0.6.8

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
`bypass_consent_gate`, `claude_resume_selection_prompt`,
`claude_gated_grants_gate`, `codex_auth_refusal` and `codex_client_incompatible`.
They are recognized from each harness's English prompt text.
`claude_gated_grants_gate` is Claude Code's workspace trust check that warns "This folder
pre-approves N tool permissions" (from the folder's `.claude/settings.json`): OpenRig never
answers it, not even with `recovery.auto_drive_provider_prompts`, because its default choice
declines those permissions (or exits) and approving them is your call. With that setting on,
the plain workspace trust prompt is answered only when its options are exactly "No, exit" and
"Yes, I trust this folder": Claude Code 2.1.322 opens it on "No, exit", so OpenRig moves the
selection down once and presses Enter only after it reads the focus on "Yes". Any other option
set, a prompt drawn without a cursor or a focus that does not reach "Yes" gets no confirmation.

## Continue a Codex fork whose child ID arrived late

For a member with `session_source.mode: fork`, OpenRig waits for Codex's new
child thread ID before sending its role and other startup prompts. It saves the
ID and sends the role only for a verified child: the bound pane's foreground
process forks the requested parent, and its own native record, matched to its
start time, supplies the ID. This capture uses `runtime.readiness_timeout_seconds`
(30 seconds by default, configurable from 1 to 600 seconds), as does the later
readiness check. The two waits have separate budgets. A seat handover with
`--source fork:<seat>` is different: its fork carries the conversation itself,
and a missed ID capture leaves the ID pending rather than stopping the handover.

If the ID is still unavailable, the seat reports `attention_required` and keeps
its startup context pending. Wait for the child to finish starting, resolve any
native prompt, then run `rig seat continue <seat>`. The continuation verifies
that the bound pane is running a fork of the requested parent and reads the
child's own native identity before delivering the saved context. It does not
launch another fork or resume the parent. The parent ID is never saved as the
child's resume token.

An unavailable or conflicting identity leaves the context pending. Once prompt
delivery has been attempted, it cannot be replayed by `continue`, including
after a daemon restart: inspect `rig seat status <seat>` and the native pane
before deciding how to recover an uncertain delivery.

## After a restored seat's prompt

A restore that stops at a prompt, such as Claude's resume selection, records the
seat's restore outcome as `attention_required`. `rig seat continue` doesn't change
that record: it only delivers pending startup context. While the record stands, it
alone keeps the seat's lifecycle at `attention_required`, even with startup `ready`:
`rig ps --nodes` shows LIFECYCLE `att`, `needsAttention` is true, and the seat counts
in the rig's `attentionCount` and the TUI's attention totals.

After a full restore of a Claude or Codex seat, answering the prompt is enough. When
the seat's activity next turns to running or idle, or when the whole restore completes
after the seat already reads running or idle, the daemon checks the live seat: its tmux
session is alive, and the agent in its pane was started to resume the conversation the
seat records. When the check passes, the restore outcome becomes `operator_recovered`, so
the restore no longer makes the seat need attention. When the check fails, the restore
outcome stays and the seat still needs attention. The check uses launch evidence; it
does not prove which conversation is open now.

`rig seat clear-attention <seat>` runs the same check on demand. When it fails, the
command says which check failed, and `--reason` doesn't bypass it. If the seat records
the wrong conversation and the agent in its pane was started with the right one, set it
with `rig seat set-resume-token <seat> --token-stdin --reason <text>`, then run
`clear-attention` again; a token the running agent wasn't started with fails the same
check. After a restore of only some seats, or a community harness's assisted startup,
`--reason "<what you saw>"` can acknowledge the outcome instead, once any startup text
left in the input box is submitted (not sent again) and the seat has responded.

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
7. Operator layer  — added by OpenRig: openrig-start.md, openrig-context-entry.md and, on a fresh start, the onboarding pack
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
| Operator | OpenRig system | System-injected runtime content | `openrig-start.md` (optional delivery); `openrig-context-entry.md`, a pointer to the skills router, help and declared context, for every seat; on a fresh start, `openrig-onboarding-01.md` and `-02.md` unless `onboarding.default_pack.enabled` is false |

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
| `guidance_merge` | Before harness boot | Merged as a managed block into the repository `AGENTS.md` (Codex, OMP), a fresh Pi seat's own agent-directory `AGENTS.md` (see [Runtime Differences](#runtime-differences)), or `CLAUDE.md` (Claude; `CLAUDE.local.md` with the rig's `managed_blocks: { claude-code: CLAUDE.local.md }`). A fresh launch of Codex 0.164.0 or later can carry it as launch developer instructions instead (see [Codex guidance at launch](#codex-guidance-at-launch)) | Role guidance, culture, project context |
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
interactive"), and the post-launch files aren't sent. A Codex fork that the rig launches (a member with
`session_source.mode: fork`, or an agent image's fork) is the exception: its timeout ends as `attention_required`,
with its startup context kept for `rig seat continue` (see below). A seat handover's fork has its own readiness check.

**Fresh Claude handovers.** `rig handover --source fresh` keeps the previous agent's scrollback. Before sending the
handover context, OpenRig waits for the latest prompt inside Claude's complete input frame, and confirms that the
process in the pane belongs to the new launch. A shell's `❯` prompt or echoed launch command is not enough, even
with an old Claude header or input frame above it and Claude already running. A header alone or a partially drawn
input frame also keeps the check pending. If the current screen or process cannot be read, or the process identity is unconfirmed, the handover keeps
waiting within the readiness window and fails if that window expires. Old screen text or the `claude` process label
alone cannot complete this check. A healthy agent can therefore remain unconfirmed while those observations are
unavailable; inspect its pane before deciding how to recover. When the launch was already sent, the failure's
guidance names that pane and the result carries `replacementStarted` and `successorPane`: the previous agent was
already ended, the new one may be working there without being registered as the seat's occupant, and another
handover or `rig seat launch <seat> --fresh --stop --reason <why>` ends it if it goes ahead.

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

**After a failure.** Delivery, launch and action failures, and readiness timeouts other than a Codex fork's, give
`failed`. Every 30 seconds the context monitor marks a `failed` or `attention_required` seat `ready` once its pane reads
ready, unless its fresh or Codex fork context is still pending for `rig seat continue`. A seat that timed out can therefore read `ready` without having received its
post-launch files. If it needs them, first look at what that occupant has done; then
`rig seat launch <seat> --fresh --reason <text>` starts a blank conversation for the seat. If the occupant is still
live, the command refuses with `session_live` unless you also pass `--stop`, which replaces that occupant deliberately.

**Preview before replacing a seat.** `rig seat launch <seat> --fresh --plan` inspects the selected
seat without starting tmux, stopping or launching a process, projecting startup files, or changing
lifecycle/queue records. Add `--json` for structured output. `--fresh` is still required;
`--reason` is optional for the preview and required when executing. Pass `--stop` to preview the
intended replacement of a live managed occupant. Adopted and unmanaged occupants remain blocked.

The plan identifies the target, current occupant, stop requirements, blockers, startup counts,
and each sibling seat's unchanged effect. Siblings stay attached and untouched. Launch composes
a new command through the runtime adapter using current settings; it does not replay a stored
wrapper command. The seat's launch environment and managed executable selection still apply.
The plan does not construct or display the launch command.

A preview is a snapshot, not a reservation or a native-readiness check. Unreadable tmux produces
`complete: false` and `launchable: null` (unknown), unless a known blocker already proves
`launchable: false`. A successful preview exits 0, including blocked or incomplete plans; scripts
must inspect `launchable === true` before deciding to execute. Request failures still exit nonzero.
Execution always resolves and checks the current state again. An older daemon without the preview
endpoint refuses the request; the CLI never falls back to executing a launch.

### Change an existing seat's working directory

Editing `cwd` in an already applied RigSpec doesn't update an existing seat's saved launch directory. Use `set-cwd` to
save a new one for the seat's next launch:

```sh
rig seat set-cwd planning-lead@project \
  --cwd /work/project/seats/planning-lead --reason "isolate planning"
rig seat status planning-lead@project
```

**The path:** it must be absolute **on the daemon's host**. OpenRig creates a missing directory, resolves symlinks to
its real path, and refuses a filesystem root.

**What it saves:** the directory and a `node.cwd_changed` audit event (from, to, reason, operator), together, in one
transaction. The seat's node, canonical address, queue, session history and skill selection stay as they are.
`rig seat status` shows **Working directory for future launches** (`launch_cwd` in JSON). That's saved configuration,
not where the running process is.

**What it writes:** it creates the folder if it's missing, and writes nothing else there. The seat's next fresh launch or
rebuild handover writes its startup files there, as launch does today.

**`set-cwd`'s preflight policy:** before saving, it reads, without writing, the enumerated resource copies (including
nested plugin files) and startup skills that launch would place in the new directory, at their actual destinations,
as they are at that moment. It's a point-in-time check, not a global overwrite guarantee or protection against later
changes; at adoption, launch applies its own policy. (The commit's re-check covers the saved startup configuration,
not the destination's file contents.)
- **Refused, with the protected paths named (`cwd_destination_conflict`):** a file there that an operator edited, an
  unrecorded file with different content, or two sources for one destination. That's stricter than launch, which
  overwrites an unrecorded differing file with a warning; the refusal is deliberate, while the occupant still runs.
- **What to do:** use a clean destination, or move or merge those files, then retry.
- **Not checked:** managed guidance blocks and native configuration merges keep the adapter's policy at launch, and
  launch-owned files such as `.openrig/context-collector.cjs` are written by launch as always.
- **A community harness** takes no startup files, so none are checked for it.

**The running occupant keeps its current directory.** Adopt the new one with:
- `rig seat launch <seat> --fresh --stop --reason <text>`, which starts a blank conversation; or
- `rig handover <seat> --source rebuild --reason <text>`, which carries durable context.

A rebuild lists the current recap, lineage lessons and restore packet as required
priming. Superseded recaps are optional history, newest first. The briefing shows
the newest `output.rebuild_recaps` paths (default 3) and their shared
`recap-superseded/` folder when that pointer covers the complete history. Other
layouts retain the full list. Set `rig config set output.rebuild_recaps 0` to
always list every path; `OPENRIG_OUTPUT_REBUILD_RECAPS` overrides the setting.
This changes only the briefing: the handover result still records every resolved
artifact, and no recap file is removed.

For Codex rebuilds, OpenRig also carries a complete supported native permission policy read from the live
predecessor's own conversation and process, without adding fresh-launch grants. A later recorded seat permission
or policy choice, or a differing declared successor profile, takes precedence. Missing, stale or unsupported observations keep the existing launch
behaviour and are reported as unverified in the handover result; requested modes and profiles alone don't prove
preservation. The result reports what was emitted, not native successor equivalence.

**Adopt it promptly.** The saved directory doesn't move the running process, but background work can use it before
adoption. Saved configuration isn't the live process's directory, and these examples aren't the only consumers. For a
running Claude seat:
- **Collector provisioning** writes `.openrig/context-collector.cjs` and merges `.claude/settings.local.json` in the
  saved directory, under its existing preservation rules.
- **Managed compaction,** manual (`POST /api/compaction/trigger`) or automatic, asks the seat to write its restore map
  under it. That may be outside the seat's current workspace, so a seat without bypass permissions may meet a write
  prompt.

Adopting promptly is guidance. It doesn't protect against a poll or a compaction that runs before your next command.

**Before adopting,** don't `rig down`/`rig up` or hand over by fork. Those resume the existing conversation in the
saved directory, and Claude keeps conversations per project directory, so a resume there may not find it.
Cross-directory resume hasn't been run natively; this is the order to follow. `rig seat restart --keep-conversation`
(Codex) isn't adoption: it respawns in the directory it observes from the running process.

**Failures:** a refusal, missing or malformed saved startup context, or an audit-write failure leaves the prior
directory saved, and changes no seat, custody or startup file (a refusal may leave the new folder created). A concurrent configuration change is reported, not overwritten. A CLI timeout means the outcome is
unknown; check `rig seat status` before retrying. Choosing the same directory again records no second event.

**The old directory:** files there are left as they are, since other seats may still use them. The source RigSpec
declaration isn't changed either; update it separately if a future recreation should use the new directory.

### The `applies_on` Field

Each startup file and action specifies when it applies:
- `fresh_start` — delivered when a new conversation starts: the first launch, `rig seat launch --fresh`,
  `rig seat continue`, and seats restored with `--fresh`
- `restore` — delivered when a seat is restored without its earlier conversation: a restore whose resume falls back to a fresh conversation, or a retried start
- Default: `[fresh_start, restore]` (both)

**An exact resume delivers neither.** When a restore reopens the seat's saved conversation (`rig up <rig> --existing` with a resume token), OpenRig types no startup actions and delivers no startup files, `restore` ones included: the conversation already has them, and typing them again would add turns to it. The one exception: the guidance file's managed blocks are brought up to date before the harness starts. A missing block is put back, and a stale one is refreshed (see below).

**A seat handover does the same put-back.** Before a fresh, fork or rebuild successor starts, the handover puts the seat's missing managed guidance blocks back in its guidance file from the saved startup context. That's the rig's Claude file (`CLAUDE.md`, or `CLAUDE.local.md` when the rig uses it) for Claude, and `AGENTS.md` for Codex, Pi and omp. So a seat rebuilt into a new working directory keeps its guidance.

**A block you edited by hand is never overwritten.** OpenRig records what it last wrote in each managed block, so a launch, an exact resume, a handover or a runtime switch can refresh a block whose source file changed since. The record follows the file itself, so two links to one file share it. A block you've edited since OpenRig wrote it is left as you wrote it. The start's result names it (`guidance_block_edited`), and the seat is told in one line once it's ready, or in a handover's packet. A block OpenRig has no record of writing (any block written before these records were kept) that differs from its source works like this:
- a launch replaces it, as launches always did, and names it (`guidance_block_refreshed_unrecorded`);
- an exact resume or a handover leaves it, and names it as possibly stale (`guidance_block_may_be_stale`).

**A file keeps one copy of each distinct block text, and tidying the copies never removes a text you wrote.**
- **Touched markers:** a marker an editor or formatter rewrapped, with spaces or line breaks inside the comment, still reads as its block, and the next write puts it back in OpenRig's form.
- **Collected copies:** a copy that repeats an earlier one exactly is removed. Beside a copy you edited, OpenRig's own unedited copies are removed too, and every different edited copy stays (`guidance_block_copies_removed`).
- **A marker that lost its pair:** OpenRig can't tell where that block starts or ends, so it adds no copy beside it and names it (`guidance_block_markers_damaged`). Put back the missing marker or remove the partial block, and OpenRig's next write treats that block like any other. `rig package install` leaves such a file as it is, names it in its result (`notes`), and installs the rest. A marker without its pair beside a complete block is named too (`guidance_block_marker_unpaired`), and the block is written.

An exact resume doesn't type anything into the resumed conversation. So there, the restore result names the block (`guidanceNotes`), but the seat isn't told.

Use this to avoid re-sending context that a fresh conversation doesn't need twice. For example, a one-time project briefing might only apply on `fresh_start`, while identity grounding should apply on both, so a seat that comes back fresh gets it again.

---

## What a seat is set to, and what it's running

A seat's settings can disagree with its running agent: what's saved for the next launch, what the running process
actually uses, and what its conversation has already read are three separate things. OpenRig reports each one
separately. Without live evidence it says unknown (or not verified), never the saved value. A saved change reaches the
running seat only through the action in the last column.

| What | Saved for the next launch | What the running seat has | How the running seat gets it |
|---|---|---|---|
| Model | `rig seat set-model` | `rig ps --nodes` shows the configured model beside the last observed one, or `UNKNOWN (<reason>)` | The next managed resume or successor launch |
| Reasoning effort | `rig seat set-effort` | `rig seat effort <seat>`: requested, saved, sent at launch, and what the session recorded, which is not verified until it takes a turn | Its next managed continuation; nothing restarts |
| Permissions | `rig seat set-permissions` (`--mode`, `--rules`, or for Codex `--codex-permissions` or `--codex-profile`), shown by `rig seat status` | What it launched with; a status read doesn't prove the running process enforces the selection | Its next managed launch or resume ([per-seat permission mode](getting-started.md#per-seat-permission-mode)) |
| Working directory | `rig seat set-cwd`, shown by `rig seat status` as **Working directory for future launches** | The directory it started in | `rig seat launch --fresh --stop` (a blank conversation) or `rig handover --source rebuild` (durable context); [details](#change-an-existing-seats-working-directory) |
| Launch wrapper (`launch_wrapper`) | Member `launch_wrapper` in `rig.yaml` (`pi`, `codex` and `claude-code` only; `launch_wrapper: []` clears, omitting retains on existing-seat apply; surfaced as `launchWrapper` in `rig ps --nodes --json` when set; no live `rig seat` edit verb) | The literal wrapper argv that prefixes the resolved Codex entry or Claude executable (preserving TTY stdio) or the resolved Pi child executable inside OpenRig's host runner (preserving RPC pipes and runner lifecycle) when that session launched; a configured prefix is not proof of isolation, tooling, memory or governance | Supported spec create/recreate/apply flow, then the seat's next managed launch, resume, restore or handover (fails closed when wrapper support is unavailable; never falls back to bare child launch; [details](rig-spec.md#launch-wrapper-runtime-pi-and-codex)) |
| Startup files and skills | The spec's startup files, skills and actions | What its conversation read when it started; editing a file afterwards doesn't reach it | A fresh launch or a handover delivers them again; for the running seat, send or walk the change (`rig walk <seat> --through <files>`) |
| Guidance blocks (`CLAUDE.md`, `AGENTS.md`) | The seat's startup selection, which OpenRig merges into its guidance file as managed blocks at each start and restore | `rig seat status` **Guidance**: when OpenRig wrote each of its blocks, before or after the session's recorded startup finish (for a claimed session, when OpenRig recorded it). That's chronology, not what the agent has: the harness reads the file earlier in startup, Claude Code reloads it after `/compact` or `/clear`, Codex reads it at session start, and the agent can read it, or be sent it, at any time. OpenRig doesn't record what an agent read | Claude: its next compaction, `/clear` or restart. Codex: its next start. Without either, [tell it](#new-guidance-for-a-running-seat) |
| Tools (MCP servers, plugins) | Selected fragments, merged into the harness's own config (`.mcp.json` for Claude, `config.toml` for Codex) | Unknown to OpenRig: registered isn't active, Claude asks before it uses a new server, and no OpenRig command reports which tools a running harness loaded | Check in the harness itself (Claude Code's `/mcp`); a running session may need a restart to pick up newly written config ([runtime config disclosure](#runtime-config-disclosure)) |

### New guidance for a running seat

There are three ways for a seat to pick up new guidance:

1. **Tell it.** `rig send <seat> "Read <file>: <why>"`, or `rig walk <seat> --through <files>` for several. The seat's
   interruption settings can hold a message; `rig send` may report `retained, not delivered`.
2. **The refocus hook**, where the seat runs OpenRig's `openrig-core` hooks (**Refocus** in `rig seat status` shows whether
   the hook has recorded it). The hook's content comes from `OPENRIG_REFOCUS_CONTENT_REF` (a `rig context get` address),
   else `OPENRIG_REFOCUS_CONTENT_FILE`, else `refocus/REFOCUS.md` under `OPENRIG_HOME`, else the shipped default. After
   compaction the hook waits for an eligible prompt. For managed Claude compaction it skips the acknowledgement boundary,
   and other prompts can arrive first and be skipped while restore is pending. Claude can also refocus after the
   conversation grows past the hook's size threshold.
3. **Its guidance file, loaded again:** for Claude at its next compaction, `/clear` or start, for Codex at its next start.
   **Guidance** in `rig seat status` shows which of OpenRig's blocks were written after the session's recorded startup finish.

A file pointer leaves the read to the seat, under its own permission settings. `rig walk` reads the named files in the
calling process and sends their contents. A seat whose harness asks before reading a file outside its project (its own
`LEARNED.md` under the topology root, a plugin's skill) waits at that prompt until someone answers it, even though a hook
could deliver an excerpt of the same file. Finding a file, a hook picking it up, and the agent reading and using it are
separate facts.

Per harness: Claude Code's and Codex's permission choices are in the setup reference
([Claude Code](getting-started.md#claude-code-a-different-launch-flag),
[Codex](getting-started.md#codex-select-sandbox-and-approvals-together)), Codex homes are
[below](#separate-codex-homes-for-separate-installations), community harnesses' limits are in
[their presets](community-harness-presets.md), and moving a live seat to the other runtime is in the
[setup reference](getting-started.md#move-a-seat-to-the-other-runtime).

---

## Deterministic Configuration

The AgentSpec and RigSpec allow declaring deterministic environment configuration:

### What the Spec Supports

**Hooks** ship inside plugins: declare the plugin under `resources.plugins[]`. AgentSpec validation refuses
`resources.hooks`. OpenRig loads one plugin's hooks into a seat itself: the shipped `openrig-core` plugin, for a Claude seat
that selects it (see [the refocus channel](refocus-channel.md#the-mechanism)). The folder a declared plugin is projected into
is not one Claude Code or Codex loads, so a plugin of your own does not get its hooks run by that projection.

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

**Don't rename a managed Claude seat.** OpenRig starts every Claude seat with `--name <session>`, on a fresh start and on
every resume, and its own reads of the seat use that name: context usage and managed compaction read the status-line
record Claude saves under it, and the input box is recognized by the name on its border. A startup `/rename` to another
name breaks those reads until the next resume puts the session name back.

### Current Support Matrix

| Capability | Status | Notes |
|------------|--------|-------|
| Guidance file projection (`guidance_merge`) | **Supported** | Reliable. Primary delivery mechanism. |
| Skill projection (`skill_install`) | **Supported** | Reliable. Skills are copied to workspace. |
| `send_text` delivery after ready | **Supported** | Reliable. Requires harness to be ready. |
| Hooks | **Through plugins, limited** | `resources.hooks` is refused. OpenRig loads the shipped `openrig-core` plugin's hooks into a Claude seat that selects it (Claude Code v2.1.280 or later); a plugin you declare under `resources.plugins[]` is projected, but its hooks are not loaded. |
| Runtime resource projection | **Supported for recognized fragments** | `claude_settings_fragment`, `claude_mcp_fragment`, and `codex_config_fragment` are applied to provider config. Unknown types are copied to runtime extension directories. |
| Permission configuration | **Native settings plus managed launch flags** | OpenRig launches Claude with `acceptEdits` and Codex with `workspace-write` unless an explicit supported selection changes them; a seat with no policy, selection or named Codex profile also gets the per-launch [team default](rig-spec.md#team-launch-defaults), and the `kernel` rig's seats get a wider operational default ([rig spec, "At launch"](rig-spec.md)). Neither is written to a settings file. Use [the first-user permission guide](getting-started.md#opt-in-permissive-operation) for opt-in and custom choices. |
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
- Global skill folders: `~/.claude/skills` and `~/.agents/skills`
  Purpose: daemon startup seeds the `openrig-skills` and `refocusing` skills and the person-facing `rigs` skill. Each
  upgrade refreshes the `rigs` skill; a copy installed another way is left as it is.

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

### Codex guidance at launch

On a fresh launch of Codex 0.164.0 or later, OpenRig passes a seat's managed guidance (OpenRig's start file and the
rig's and project's context, culture and SOP files) with the launch, as `-c developer_instructions=…`, instead of
merging it into the repository `AGENTS.md`. Neither the tracked `AGENTS.md` nor the Codex home is written for it, and
both still load as usual. The text opens: "OpenRig seat guidance for this session follows. Where it conflicts with
AGENTS.md guidance in the repository or the Codex home, follow AGENTS.md."

A launch value replaces a configured one, so this happens only when no Codex config layer OpenRig reads sets
`developer_instructions`. OpenRig reads:

- `/etc/codex/config.toml` and `/etc/codex/managed_config.toml`;
- the Codex home's `config.toml`, profiles included, and the selected profile's `<profile>.config.toml`;
- each `.codex/config.toml` from the seat's working directory up.

The Codex home it reads is the seat's own (a `CODEX_HOME` in its `env:`, or a recorded account switch), else the
daemon's `CODEX_HOME`, else `~/.codex`.

The guidance still goes to the repository `AGENTS.md`, as before, when:

- a layer OpenRig reads sets `developer_instructions`, or can't be read. A launch warning names the file;
- the launch forks a conversation. Developer instructions on a fork haven't been tested;
- the seat is restored and the restore starts a new conversation. A restore keeps the guidance file its launch
  recorded, which for Codex is the repository `AGENTS.md`;
- a handover successor starts (fresh, fork or rebuild). Its launch carries no guidance of its own, so the handover
  first puts the seat's missing blocks back in the repository `AGENTS.md` from its saved startup context;
- Codex is older than 0.164.0, or its version is unknown.

A resume of the seat's own conversation, on a snapshot restore or `rig up --existing`, chooses as a fresh launch
does: on Codex 0.164.0 or later with none configured, the guidance blocks the repository `AGENTS.md` doesn't hold go
with the resume as `-c developer_instructions=…` instead of being put back in that file, and the guidance file its
launch recorded isn't changed. A file that already holds blocks keeps them: a block OpenRig wrote whose source has
changed is refreshed, and one edited by hand, or with no record of OpenRig writing it, is left as it is and named. A
block whose source is gone or can't be read isn't sent, and the restore reports it as missing. A seat in a rig without
pods starts its resumed conversation before its startup runs, so its missing blocks are still put back in the
repository `AGENTS.md`. Whether Codex keeps the earlier session's developer instructions as well isn't documented
by Codex; the text sent with the resume is the current one.

A seat's role still arrives as startup text, and the seat-skills line, after the person's yes, still goes to
`AGENTS.md`.

A launch that carries developer instructions writes no new blocks to the repository `AGENTS.md`. But blocks an earlier
handover or resume left there are refreshed from their sources, by the same rule as every other managed block. That
matters because the launch text asks Codex to follow `AGENTS.md` where the two differ.

**If your shell sets `CODEX_HOME`.** When neither the seat nor the daemon declares a `CODEX_HOME`, a seat's pane keeps
its own, and OpenRig reads `~/.codex`. A `CODEX_HOME` that only your shell startup sets (in `~/.zshrc`, for example),
with the daemon started without it, isn't seen. A `developer_instructions` set in that home is then replaced by the
launch value for the session. To have it checked, declare that same absolute path as `CODEX_HOME` in the member's or
rig's `env:` (see [Launch environment](rig-spec.md#launch-environment), "A seat's own account"). OpenRig then reads
that home at the seat's next fresh launch, and a `developer_instructions` set there keeps the repository `AGENTS.md`.
The seat keeps the same home and login.

**What it doesn't cover.** OpenRig doesn't read Codex's packaged defaults, or MDM- or enterprise-managed settings. A
`developer_instructions` set there may be replaced for the session. Legacy MDM-managed config ranks above launch flags,
so it can override OpenRig's guidance, and the seat then gets none of it.

**Not established.** The order Codex assembles developer instructions and `AGENTS.md` in, and how it settles every
conflict, aren't established; the opening sentence asks it to follow `AGENTS.md`. The native behaviour was observed on
Codex 0.164.0 alone, on fresh launches without tools.

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
- Managed launches pass `-c check_for_update_on_startup=false`, so Codex skips its startup update check; your Codex
  config is not changed.
- Can self-install dependencies from instructions but timer/recurring behavior is not reliably available

**Pi and OMP:**
- Read `AGENTS.md` in the working directory, added to Pi's own system prompt. Pi also reads the one in its agent
  directory: on a fresh launch, a Pi seat's guidance is merged there, under OpenRig's state, not into the
  repository's. When that file or its directory is a link, the repository `AGENTS.md` is used instead. A restore keeps
  the file the seat launched with. OMP keeps its guidance in the repository `AGENTS.md`
- Selected skills are projected into the seat's own agent directory under OpenRig's state, not into a shared
  workspace folder

For Pi tool-selection diagnosis and deliberate in-place recovery, see
[Pi tool-selection recovery](pi-tool-selection-recovery.md). It distinguishes
configured, currently intended, registered and active tools, including the TUI/RPC boundary.

**Terminal seats** (`builtin:terminal`) get no agent or profile layers and no startup proof.

### Claude compaction preparation directory

Managed Claude compaction asks the seat to write a restore map before `/compact`. By default,
OpenRig uses `<cwd>/.openrig/compaction/preparation/`, falling back to its instance home when
that directory cannot be prepared. A filesystem write check cannot establish whether Claude's
file-edit permissions allow the seat to write there.

If the launch workspace is denied by Claude's permissions, select an absolute preparation root:

```sh
rig config set policies.claude_compaction.preparation_root /absolute/path/to/restore-maps
```

Grant the seat file-edit access to that root in its Claude configuration. OpenRig does not change
Claude permissions; choose a directory outside any matching deny rule. The corresponding environment
variable is `OPENRIG_POLICIES_CLAUDE_COMPACTION_PREPARATION_ROOT`.

New manual and automatic attempts use `<root>/<session>/<attempt-id>/RESTORE-MAP.md`; an in-flight
attempt keeps its original path through the post-compaction restore request. The root gets an
exclusive `.gitignore` containing `*`, and the daemon publishes the marked `.tmp` file with an
atomic rename. Use a dedicated root: a conflicting
ignore file or an unwritable configured directory stops preparation with
`preparation_directory_unavailable`, visible in `rig compact <session> --state`, without choosing
another location. Fix the directory and explicitly retry. `--skip-map` still skips the map once.

Reset with `rig config reset policies.claude_compaction.preparation_root` to restore the default.
The setting applies to new attempts without restarting the daemon.

The managed `/compact` command keeps its 600-character budget. When the selected map path or
the attempt's compaction instruction does not fit, the existing restore request carries it;
it never substitutes a newer preparation root or instruction. An explicitly selected root's
published map is also named in that request when the path fit in `/compact`. The default root
keeps the existing command/restore handoff. Under `--skip-map`, restore still recognizes an
optional map completed at that attempt's path, or says that no map was required.

The compaction preparation and command-submission tests cover manual and automatic attempts,
long paths and instructions, settings changed during preparation, directory failures and
late maps after cancellation or expiry. They use synthetic delivery and filesystem fixtures;
they do not prove a live Claude session's permission choices or compaction behavior.

### Codex compaction and sizing

OpenRig's managed compaction is for Claude Code seats only, by design. That covers `rig compact`, the
`policies.claude_compaction.*` automatic policy, and the watchdog jobs that the `managed-compaction` and
`apprentice-handover` strategies create. A Codex seat compacts with Codex's own automatic compaction, and OpenRig
leaves that to Codex.

- `rig compact <session>` refuses a Codex seat: "not a Claude (claude-code) seat".
- `rig compact-plan` lists a Codex seat as skipped (`codex_not_managed_by_claude_compact_in_place`).
- The automatic policy never acts on a Codex seat.
- A Codex member with `compaction_strategy: managed-compaction` or `apprentice-handover` gets no watchdog jobs.

**What Codex compacts at.** Codex describes `model_auto_compact_token_limit` as the "token threshold that triggers
automatic history compaction (unset uses model defaults)". Its configuration reference does not say what those
defaults are, and the model catalog's `auto_compact_token_limit` is null for the models we checked in Codex 0.162.1.
Measure a seat's own compactions before relying on an unset limit.

**What window the model has.** `codex debug models` prints the catalog. Each model carries `context_window`,
`max_context_window` and `effective_context_window_percent`. In Codex 0.162.1, `gpt-5.6-sol` has a `context_window`
of 272000 at 95%, which is 258400. That is the `model_context_window` its rollout `token_count` events report.
A limit only matters when it is below that effective window. Leave `model_context_window` alone: don't raise it toward
`max_context_window` to avoid compaction. Set the limit instead.

**Setting the limit for seats only.** Put `model_auto_compact_token_limit` in a Codex profile file,
`$CODEX_HOME/<name>.config.toml` (`~/.codex/<name>.config.toml` when `CODEX_HOME` is unset), and name it on each
Codex member that should use it:

```toml
# ~/.codex/seat-compaction.config.toml
model_auto_compact_token_limit = 150000   # choose your own value
```

```yaml
codex_config_profile: seat-compaction
```

OpenRig passes `-p seat-compaction` on that seat's fresh, fork and resume launches. Codex layers the profile file on
top of the base user config, so only seats that name the profile see the lower limit. A Codex session started without
that profile keeps the base `config.toml` in the same Codex home (`$CODEX_HOME/config.toml`, or `~/.codex/config.toml`
when `CODEX_HOME` is unset). The `150000` is an example, not a recommendation.

With the normal launch mode, `codex_config_profile` replaces OpenRig's explicit workspace-write sandbox flag, so the
profile must set the sandbox and approvals you want. See
[permission precedence and limits](getting-started.md#custom-settings-and-precedence), which also gives Codex's order
of precedence between a profile, project settings and CLI overrides.

**The trade-off.** Every model call carries the whole context so far, so a smaller context makes each call cheaper. The
cost is that Codex compacts sooner and more often, so more of the conversation is carried as a summary instead of
verbatim. A higher limit keeps more detail and makes each call larger.

**Related keys.** These also shape compaction. This guide doesn't recommend values for them. See Codex's
[configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference):

| Key | What Codex says it does |
|---|---|
| `model_auto_compact_token_limit_scope` | `total` (the default) counts the full active context; `body_after_prefix` counts only growth after the carried compaction-window prefix. |
| `compact_prompt` | Inline override for the history compaction prompt. |
| `experimental_compact_prompt_file` | Loads the compaction prompt override from a file (experimental). |
| `tool_output_token_limit` | Token budget for storing individual tool or function outputs in history. |

When authoring startup content, note which instructions are runtime-specific. For example, an orchestrator that needs a monitoring loop should include instructions like: "If running Claude Code, use `/loop 3m` to periodically check rig health. If running Codex, check rig health at the start of each task cycle instead."

---

## Files OpenRig writes into a project

These are the files OpenRig writes into a seat's working directory, and what `rig down` does with each. Paths are
relative to that directory.

| Path | When OpenRig writes it | What `rig down` does |
| --- | --- | --- |
| Managed blocks in `CLAUDE.md` (or the rig's `managed_blocks` file, such as `CLAUDE.local.md`) or `AGENTS.md` | Each launch merges the seat's guidance blocks. A fresh Codex launch that takes developer instructions puts them in its launch text instead: in `AGENTS.md` it adds only the seat-skills line, after your yes, and refreshes blocks already there. A fresh Pi seat writes its own agent-directory `AGENTS.md` outside the project, except when that folder or file is a link: then its guidance stays in the repository `AGENTS.md`. | Removes OpenRig's blocks, current or legacy, and keeps everything else. When nothing else is left, it deletes the file if the file began with an OpenRig block, or held only blocks in an older format. A block-only file isn't proof that OpenRig created it. The seat-skills line is kept if you edited it. |
| `.openrig/context-collector.cjs` | Claude seats, at launch. | Removes it while its bytes are still the shipped collector's; otherwise keeps it and says so. |
| `.claude/settings.local.json` | Claude seats, at launch: OpenRig's status line and its activity hooks are merged in, separately. Your own status line is never replaced, but the activity hooks are still merged beside it. A file that doesn't parse gets neither. | Removes OpenRig's status line and hooks and keeps the file, even if `{}` is all that's left. |
| `.claude/settings.local.json` fragments and `.mcp.json` | When a profile or spec declares `claude_settings_fragment` or `claude_mcp_fragment`. | Leaves the merged content in place. |
| `.claude/agents/`, `.claude/plugins/<id>/`, `.claude/extensions/<id>/`; `.agents/<id>.yaml`, `.codex/plugins/<id>/`, `.agents/extensions/<id>/` | When the seat's projection includes subagents, plugins or runtime resources (Claude, then Codex). | Leaves them in place. |
| `.claude/skills/<id>/`, `.agents/skills/<id>/` | Only for a seat without seat storage. New Claude and Codex seats keep their skills under `$OPENRIG_HOME/state/seats/`, outside the project. | Leaves them in place. |
| The managed compaction preparation folder described in [Claude compaction preparation directory](#claude-compaction-preparation-directory), with its `.gitignore` of `*` and each attempt's `RESTORE-MAP.md` | Managed Claude compaction, unless a preparation root is configured elsewhere. | Leaves it in place. |
| `.rigged-checkpoint.md` | A restore that didn't resume a seat's native conversation (by choice or not) and had a checkpoint to hand it. | Leaves it in place. |

`rig down` leaves a file alone while another seat still uses it: a running seat of the same rig, or any seat of
another rig that isn't archived. That is decided file by file. A guidance file is kept while another seat's
guidance targets the same file. The Claude settings and collector are kept while another Claude seat works in that
directory. So another rig's Codex seat keeps `AGENTS.md` without keeping `CLAUDE.md` or the Claude settings. It
removes `.openrig/` and `.claude/` only when they are empty.
`rig down --delete` does nothing more to project files. OpenRig doesn't edit your project's own `.gitignore`.

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

The other shipped agent specs that start a seat with `guidance/role.md` mark that
file `orientation: role` too, so `rig queue whoami --json` reports their role and
refocus names it. They never projected a role into shared guidance; their startup
delivery is unchanged.

**Removing a leftover shared role block by hand.** A kernel installed before 0.6.5
may still hold one seat's old role in its working directory's `CLAUDE.md` (or the
rig's configured `managed_blocks` file) or `AGENTS.md`. Upgrading doesn't remove it.
`rig down` removes OpenRig's managed blocks from that file when no other running
rig uses it, so it stays until then. To remove it sooner, by hand:

1. Find the exact block: the lines from `<!-- BEGIN OpenRig MANAGED BLOCK: role -->`
   through `<!-- END OpenRig MANAGED BLOCK: role -->` (in older files, `RIGGED`
   instead of `OpenRig`). Only the block whose id is exactly `role`; leave
   `rig-role`, other ids and everything outside the markers alone.
2. Confirm each seat that shares that directory has its per-seat replacement:
   `rig queue whoami --json` run in the seat reports `role.state` as `present`.
   A seat started before it was upgraded still has the old content in its
   conversation; restart it fresh if you want it to start from the per-seat role.
3. Keep a copy of the file, remove only those lines, and compare the result with
   the copy: nothing else in the file should differ.

**The kernel's own folder.** A newly created default kernel works in
`<workspace.root>/kernel`, beside your projects (`<workspace.root>/projects` by
default) rather than above them. Claude reads `CLAUDE.md` from a seat's folder
and from every folder above it, so a kernel working in the workspace root put its
guidance into every Claude project seat below it. If that folder can't be made,
the new kernel works in the workspace root, as before.

A kernel that already exists keeps its folders, usually `workspace.root`.
Upgrading moves no seat, changes no restored conversation and removes no file.
To move an existing kernel yourself, if you want to:

1. Save the new folder for each kernel seat with `rig seat set-cwd <seat> --cwd
   <workspace.root>/kernel --reason <text>`, using the absolute path. It creates
   the folder ([details](#change-an-existing-seats-working-directory)).
2. Choose when each seat adopts it. A seat keeps its current folder until it
   starts again, and the new start doesn't continue its current native
   conversation: `rig seat launch <seat> --fresh --stop --reason <text>` starts a
   blank one, and `rig handover <seat> --source rebuild --reason <text>` carries
   durable context into a new one. Nothing does this for you.
3. Tidy the old `<workspace.root>/CLAUDE.md` (or `AGENTS.md`) by hand, once no
   running rig's seat still works in that folder: a seat there still reads those
   blocks, and `rig down` checks the same before it removes them. Remove only
   OpenRig's managed blocks, each from its `<!-- BEGIN OpenRig MANAGED BLOCK: … -->`
   line through its `END` line, as in the steps above, and keep everything else,
   including your own text. Don't move or delete the whole file.

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
