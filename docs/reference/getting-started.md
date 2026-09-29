# Getting started: one useful change in your repository

Start with a repository and one bounded change you can exercise. The shipped
first-project recipes provide the same two seats: an outcome owner and an
independent checker. Choose Claude Code, Codex, or one of each using the accounts
you already have. Terminal-provider support does not change the harness or login.

You need Node.js 22 or 24 and tmux, on macOS or Linux. On a Mac with Apple
silicon, use Node.js 22 (see the [compatibility
history](../releases/v0.5.15.md#known-compatibility-limitation)). Native
Windows is not supported yet, and WSL2 has not been tested. Node 20 is no longer
supported; Node 26 and other versions are untested.

**Choose permissions before starting the team.** Ordinary OpenRig launches use
Codex's `-s workspace-write`, with approval policy from your native configuration,
or Claude Code's `acceptEdits`, which still leaves commands subject to native
rules and prompts. Codex's sandbox normally blocks network access, including the
local OpenRig daemon. A command allowance does not change general sandbox/network
settings. The starter's `profile: default` selects OpenRig resources, not a native
permission profile.
Agent-guided setup [asks once](#have-your-agent-configure-permissions): “Allow
your agents to run OpenRig commands without repeated permission prompts?”
**Yes — recommended** / **No — keep prompts**. An existing explicit choice is
reused; No or no answer leaves settings unchanged. Broader access is separate.

> Everything below reports **what is currently true**, never a guarantee that
> downstream work will succeed. "Daemon up" does not mean every agent is healthy;
> "kernel ready" does not mean every kernel agent is healthy; a workspace root
> being *live* does not mean it is the *right* one for your project.

## Prepare and launch

Type `rig` in an ordinary terminal to open the startup and work TUI. It shows
the daemon address; **d** expands the selected instance path and diagnostics.
If the daemon is stopped, press Enter
to start that daemon, then choose the rigs and seats you want. Kernel is
recommended first; selecting its operator does not start every kernel seat.
The same view is available with **S** from ordinary TUI work.
**?** opens Help even while connection checks are pending. **w** skips startup;
**Esc** goes back, or leaves startup from its first page. These choices do not
start a daemon or a seat. **L** opens local reading before or after connecting:
choose configured Specs, project intent, projects, or missions and slices, then
select a directory or file. **r** reads the selected source again; **Esc** returns.
Local reading uses this machine's configured workspace paths and file allowlist,
including when the selected daemon address is remote. It shows disk provenance,
missing or denied sources, binary files and the 1 MiB text truncation boundary.
These disk snapshots may change after reading and do not supply live queue,
execution or topology state. Live views load after a confirmed connection and
deliberate entry; a stalled live read does not prevent Help or local reading.
When terminal transport is unavailable, **t** starts the empty terminal service
so recovery choices can be inspected. It launches no seats.

For a previously occupied seat, Enter attempts its previous conversation.
If history is unavailable, read the reason. **f** opens a separate fresh-start
decision for that named seat; **Esc** declines without launching it. A confirmed
fresh conversation receives the configured context and retains the old history,
but does not resume that history. Authentication or runtime failures require
repair of that prerequisite. **o** opens the existing native terminal here; detach
to return (tmux defaults to Ctrl-b, then d). Decide native trust/auth prompts
there. If a fresh start paused before context delivery, **c** finishes that
delivery to the same occupant. **r** reads actual state again; **d** expands details.

### Choose your providers

Ask: **“Which working account do you want this team to use: Claude Code, Codex,
or both?”** Reuse an explicit choice already made. Recommend the account the
user already has working; a second subscription is not a prerequisite.

| Choice | Starter name | Owner / checker runtime and model |
| --- | --- | --- |
| Two Codex agents (existing route) | `first-project` | Both `codex`, pinned `gpt-6-astra` |
| Two Claude agents | `first-project-claude` | Both `claude-code`, configured native default model |
| One of each | `first-project-mixed` | Claude owner (native default); Codex checker (`gpt-6-astra`) |

Claude uses the same unpinned model convention as the existing Claude kernel and
implementation-pair recipes: OpenRig does not pass a model override. Read the
selected harness's configured model and show it alongside the recipe and launch
command before proceeding. Confirm account access to any pin; if unavailable,
ask for a supported model choice rather than silently substituting a model or
provider. After launch, confirm the actual native model before assigning work.

Install OpenRig and check `tmux -V`. Check **only the selected providers**:

- Claude Code: `claude --version` and `claude auth status`. If sign-in is missing,
  ask once: “Please run `claude auth login` in your launch environment.”
- Codex: `codex --version` and `codex login status`. If sign-in is missing,
  ask once: “Please run `codex login` in your launch environment.”

Install a missing selected CLI using its provider's installation instructions.
The other provider's CLI/login and Herdr/cmux are optional. Do not copy credentials
or start repeated sign-in attempts. Recheck the selected login after the user
completes it. `rig setup --dry-run` previews the broader setup; applying
`rig setup` installs/checks **both** harnesses and cmux, so it is optional for
this selected-provider path, not a requirement to fix an unused provider.

### Kernel startup stays automatic

On a fresh instance, ordinary daemon startup chooses the kernel variant from
successful native auth probes: Claude alone, Codex alone, or both. Thus an absent
unused provider is fine. The project recipe does **not** constrain that probe:
if both accounts are authenticated, automatic kernel startup uses both, even
when the two project agents use just one provider. No manual kernel setup is
needed for this journey. The starter choice is not an instance-wide provider
restriction; a request to use only one provider for everything is separate.
Preserve any existing managed kernel and working rigs.

### Launch the two project seats

Set `starter` to the chosen name from the table; the existing Codex route remains:

```sh
cd <your-repository>
starter=first-project  # or first-project-claude or first-project-mixed
rig specs preview "$starter" --kind rig
rig up "$starter" --cwd . --plan
rig up "$starter" --cwd .
rig status
rig ps --nodes --rig "$starter"
```

Preview the selected seats, models and resources. Plan checks resolution and
preflight for the working directory. Launch starts the daemon if needed, with
the kernel behavior above. Read readiness for the project seats, not only daemon
health. Resolve a named authentication, trust or permission prompt before giving
that seat work. No new team is needed when returning to an existing project.

When a seat pauses, open its existing terminal with **o** in the startup view.
Read the proposed command, working directory and target instance. For an intended
local `rig` call, choose the native prompt's one-time approval if that is the scope
you want; a saved command-prefix allowance also affects future matching calls.
Decline an unexpected operation and tell the same agent what to do instead.
Approval controls whether an action may run; the sandbox controls its filesystem
and network access. Turning approvals off does not grant network access.

After answering, watch for the command's result and the agent continuing. Read
the corresponding queue row and transition from your ordinary terminal. If an
operation timed out, read its result before asking for another attempt: it may
already have taken effect. A delivered message or disappearing prompt alone is
not progress. If startup is still waiting for context delivery, use **c** for the
same occupant, then **r** to refresh. Do not start another seat to clear a prompt.

These starters are deliberately small starting points, not universal teams.
For a different installed runtime or team shape, inspect `rig specs ls --kind
rig` and `rig specs preview <name>` before selecting it. A seven-seat showcase
is optional and consumes more concurrent capacity.

## Give the owner an outcome

For example, in a project that imports CSV files:

```sh
rig send "dev-owner@$starter" 'Improve the CSV import error when a required column is missing: name the column and leave the existing data unchanged. Add a regression check, ask dev-check for an independent check of the exact candidate, and record the result and how I can try it. Keep the change local; do not publish.'
```

Replace the example with a real problem in your repository. Include what the
user should observe, a boundary and how success can be checked. The owner
creates and claims a durable task, implements it, and routes the selected
independent check. You should not have to relay the review between terminals.
`rig send` is the initial conversation; the queue and repository artifacts
retain the work. An unbound shell does not need to impersonate a queue owner.

Use the chosen rig name in its seat addresses (for example,
`dev-owner@first-project-claude`). From an actual project seat, follow the work with
`rig queue list --limit 1000`: its default scope is the caller's current rig.
`queue list` has no `--rig` option. From an observer shell or another rig, use
`rig queue list --destination "dev-owner@$starter" --limit 1000` and the same
command for `"dev-check@$starter"`, after verifying those live addresses.
These show each destination's obligations, not a whole-rig view. An unbound shell
must not pretend to be a seat to change scope; use `--all-rigs` only when that
broader view is intended. Then read `rig queue show <id> --full` and
`rig queue transitions <id>`. A delivered message is not a reviewed result.
Read the artifact, exercise its behavior, and check the candidate reviewed.

## Share the dashboard and return to it

```sh
rig tui --shared
```

A fresh kernel runs the ordinary TUI in its existing `operator-human` terminal.
This command attaches another client to that terminal. **Ctrl-b, then d**
detaches without quitting the TUI; return with the same command and the view
stays where it was. Another authorized agent can capture or operate that same
pane. It should tell you before changing your view. The terminal is not a
human inbox and does not prove anyone is watching it.

Plain `rig tui` remains an independent local view. If an older kernel or a TUI
you quit shows a shell, run `rig tui` in that shell once. `--shared` does not
start or replace a terminal, so a missing binding is reported with recovery
guidance rather than creating a second kernel.

Herdr users follow the same launch and task path. To place the managed team in
Herdr, use `rig terminal open "$starter" --provider herdr`; for the shared
dashboard, use `rig terminal open kernel --provider herdr`. The equivalent
cmux provider is also available. Read the opened/absent/degraded result: a
partial terminal view is not a healthy team. Repeated terminal-open calls can
create another provider workspace; return to the one already open when you
want to preserve it. This is terminal integration, not native plugin enrollment.

## Continue real project work

Return to the same owner with the next outcome, citing the earlier result.
The seat address and durable queue survive closing your viewing terminal.
Keep intent, acceptance and evidence in the repository's existing project,
mission and slice artifacts; the starter reads those before inventing a path.

If the project has no work tree, start with `rig workspace doctor` and
`rig scope mission create --help`, then `rig scope slice create --help`. Set
the actual intended outcome before creating work. `rig scope` retains what is
being built. When repeated coordination warrants a workflow, discover with
`rig workflow specs`, inspect its owners and inputs, and instantiate the
selected name with `rig workflow instantiate --help`. A workflow is not needed
merely to make the first local change.

For a continuing team, [OpenRig Software Factory](../../packages/daemon/specs/agents/shared/skills/core/openrig-software-factory/SKILL.md)
offers manual/team work, queue-supported orchestration without Workflow, and an
optional explicit Workflow path, with wake defaults, token costs and permission
choices visible. Give its short request to your existing agent. After
installation, discover the compatible bundled recipe with `rig context show
skills/core/openrig-software-factory --json`; retain a missing/version-mismatch
result rather than silently using newer instructions. Its growth section keeps
three choices clear: stay with the pair, add one or two seats to the running rig
with `rig grow` and no YAML, or optionally author a custom rig. It covers
new-seat context/work ownership, concurrency costs and saving the expanded spec.
This guide remains the short first-use path.

## Incomplete setup and restart

| Observation | Next action |
| --- | --- |
| Tool missing or login fails | Use the specific setup/auth hint; recheck that executable in the launch shell. Do not send work to an unready seat. |
| Daemon is healthy, kernel is still starting | Read `rig status` and `rig ps --nodes --rig kernel`; kernel readiness is separate. |
| Shared terminal is absent | Inspect the existing kernel binding and recovery state; use standalone `rig tui` while resolving it. |
| Viewing terminal was closed | Reattach with `rig tui --shared`; do not relaunch the team. |
| Daemon restarted but tmux survived | Re-read `rig status` and the existing queue; a daemon restart is not a fresh project. |
| Host reboot lost tmux sessions | Open `rig`, start the daemon if needed, and select the existing rig and seats. Resume is the default; a fresh conversation needs a separate decision. |
| Launch reports no usable snapshot | Inspect the existing rig and retained project files, then follow the same-seat recovery below. |
| Work is waiting on a prompt or decision | Read the row, transition and named prompt; preserve the obligation until the missing decision arrives. |

If a snapshot is unavailable, the startup view checks the selected seat's
retained startup source and authoritative occupant relation. It reports a
missing or ambiguous source instead of selecting an arbitrary historical row.
Repair the named source, retry, or leave the seat stopped. Check the retained
queue, project notes and observed result before continuing work.

`rig setup` prints the short form of this path; `rig status` points back here.

## Kernel framing (what `rig setup` does and does not do)

Explicit CLI daemon startup retains its automatic kernel behavior. The TUI
starts the daemon with kernel auto-boot disabled so the user can select seats:

- `rig setup` installs/verifies the runtime; it does not start the daemon or the
  kernel.
- Starting the daemon (`rig daemon start`, or implicitly via `rig up`) is what
  boots the kernel rig in the background.
- Starting it from bare `rig` prepares no agents automatically. The TUI offers
  kernel setup and individual seat selection after connecting.
- **Kernel readiness is a distinct signal from daemon health.** The daemon's HTTP
  health binds early; the kernel can still be booting or a kernel agent can be
  unhealthy while the daemon is up. `rig status` surfaces kernel readiness
  separately (via `/api/kernel/status`); `rig daemon start --wait-for-kernel`
  polls it.

## The scope <-> workflow bridge

Two related primitives, often confused by new operators:

- **`rig scope`** manages **durable, on-disk artifacts** - missions and slices
  (markdown/YAML files in your workspace). These are the persistent record of
  *what work exists*.
- **`rig workflow`** manages a **runtime instance** - when you
  `rig workflow instantiate <name>`, the daemon creates a workflow instance plus
  an **entry qitem** that routes the first step to an owner. This is the live
  coordination of *who does the next step*.

Scope files retain what the work is; workflow instances and their queue packets
retain who acts next. Creating or editing a mission does not start work. You can
instantiate a named workflow with `rig workflow instantiate <name>`, or explicitly
inspect an authored lifecycle with `rig workflow compile` and create its runtime
with `rig workflow instantiate-lifecycle`. Compilation alone does not start work.
[OpenRig Software Factory](../../packages/daemon/specs/agents/shared/skills/core/openrig-software-factory/SKILL.md)
shows a small reviewed example and how to retain custody through a genuine wait.

## Have your agent configure permissions

Before team launch, your agent asks once, unless you already made an explicit
choice for these harnesses and this scope:

> Allow your agents to run OpenRig commands without repeated permission prompts?
> **Yes — recommended** / **No — keep prompts**

This covers the entire `rig` family, including starting/stopping agents,
configuration and launching processes. It is not global YOLO or permission to
invent work. The scope is your personal settings for this project unless you
explicitly choose user-wide sessions, which can affect your other projects.

On an actual **Yes**, the agent backs up the relevant files, adds the existing
native rules without duplicates, and preserves stricter rules and unrelated
settings. It checks bare and actual absolute-path invocations, rule loading and
repeated harmless reads in the target conversation. No or no answer leaves
settings alone and continues with existing prompts. Unsupported scope or a
managed restriction is reported; it is not permission to grant broader access.

The agent remembers an explicit choice, scope and exact additions in existing
onboarding context, so setup does not ask again. You do not need to approve each
routine edit separately. To undo, say **“Undo the OpenRig command allowances
added by this setup; keep my other rules.”** The agent removes only its recorded
additions, preserves earlier rules and later edits, and verifies reloading.
Other pre-existing allowances may still permit commands after this undo.

Use the maintained **Applying a permission policy** procedure:

```sh
rig context get skills/applying-a-permission-policy/SKILL.md
```

In a source checkout, read [its source](../../packages/daemon/assets/plugins/openrig-core/skills/applying-a-permission-policy/SKILL.md).
In an npm installation, the same file is under
`@openrig/cli/daemon/assets/plugins/openrig-core/skills/applying-a-permission-policy/SKILL.md`
below the matching `npm root -g` or local `npm root`. Use the version supplying
your `rig` executable. It covers Codex/Claude command rules, actual config roots,
preserving restrictions and verifying the target conversation. A missing guide or
unsupported native version is a reported gap, not permission to silently bypass.

The broader launch-mode recipes below are optional. Command-family rules do not
require changing the starter's sandbox or everyone else's defaults.

## Opt-in permissive operation

Permissive operation lets agents act with your account's filesystem and network
access with fewer permission stops. They can damage files or send data without
another confirmation. Use it only for work and an environment you deliberately
trust; it does not supply missing credentials or override organization policy.

Make changes in a **user-owned spec before its first launch**. To customize the
starter, run `rig specs show first-project --kind rig` and find its `Path`, ending
in `specs/rigs/launch/first-project/rig.yaml`. Copy that whole `specs` directory to
`./openrig-specs` in your repository, keeping its layout: copying only `rig.yaml`
breaks its relative agent and culture references. Leave the installed copy alone.
The examples below use `./openrig-specs/rigs/launch/first-project/rig.yaml`. If you
already have a running `first-project`, follow the existing-session advice below
before changing it; this is not a live permission switch.

### Codex: select sandbox and approvals together

For Codex versions supporting named `.config.toml` profiles, create
`~/.codex/first-project-permissive.config.toml` (under `CODEX_HOME` instead if you
set it for the daemon's launch environment):

```toml
sandbox_mode = "danger-full-access"
approval_policy = "never"
```

In the copied rig, add this field to **each Codex member** that should use it;
keep the member's existing `profile: default`:

```yaml
codex_config_profile: first-project-permissive
```

Leave `permission_policy` absent or set it to `none`, with no member-level YOLO
override. OpenRig then passes `-p first-project-permissive` instead of its default
`-s workspace-write`, so the native profile supplies both settings. Higher-priority
native project configuration or managed requirements can still change/refuse the
result. Inspect native `/status` before assigning work.

```sh
rig policy current --spec ./openrig-specs/rigs/launch/first-project/rig.yaml
rig up ./openrig-specs/rigs/launch/first-project/rig.yaml --cwd . --plan
rig up ./openrig-specs/rigs/launch/first-project/rig.yaml --cwd .
```

OpenRig's `permission_policy: builtin:yolo` setting selects
`-s danger-full-access -a never` on fresh, resume and fork launches, replacing
the named-profile argument. The profile recipe above remains useful when you
want to maintain those choices in native configuration. The legacy
environment-only `OPENRIG_YOLO=1` path remains sandbox-only when no resolved
policy is present. A standalone `codex --yolo` command is not an OpenRig setting.

To return to a restricted next launch, change the selected profile to:

```toml
sandbox_mode = "workspace-write"
approval_policy = "on-request"

[sandbox_workspace_write]
network_access = false
```

### Per-seat permission mode

Permission mode is the native execution choice; work posture is project guidance.
For an existing managed seat, select future-launch permissions explicitly:

```sh
rig seat set-permissions owner@first-project --mode full_bypass --reason "Operator selected broader access"
rig seat status owner@first-project --json
```

This records the actor, reason and old/new choice on that seat. It does not
relaunch it, alter native history, change sibling seats, or edit permission
rules/hooks. A later lifecycle action remains a separate decision. The explicit
seat choice overrides the inherited member/rig policy; `--mode inherit` clears
it without changing that inherited policy. `floor` selects the existing normal
launch path (including a Codex named profile when configured); it does not
rewrite a native profile or force its approval settings.

Codex and Claude accept `floor` and `full_bypass`. Additional Claude native modes,
including `auto`, require support advertised by the managed executable's help.
OpenRig resolves the first executable on its managed launch PATH at the seat's
absolute working directory, then uses that exact path for discovery and launch.
It does not use interactive shell aliases or a shell's modified PATH. Relative
PATH entries and a relative `CLAUDE_CONFIG_DIR` resolve from the seat directory.

For these explicit native modes, fresh, resume, fork and legacy restore use the
same managed environment: PATH, HOME, `CLAUDE_CONFIG_DIR` (default HOME/.claude)
and the configured classic-renderer setting. Other shell customizations are
excluded. The existing managed identity and allowlisted provider-auth channel
is retained by variable name; credentials are not copied into launch commands
or capability evidence. Help runs without that credential channel. Existing
login files remain under the managed home. Configure the daemon's managed
launch environment deliberately before selecting a mode; this is not a probe
of an arbitrary interactive shell.

Each selection and each later launch checks support again, without a cache.
A changed node/occupant, binding, cwd, executable or capability environment
refuses at the next check: after help, before selection/audit mutation, and
immediately before paste and Enter. A failure after a valid paste is partial
input, not a successful launch or a claim that earlier input was rolled back.
An existing explicit selection is retained on refusal; no fallback is chosen.
Ordinary and inherited launch paths are unchanged. The status response
distinguishes desired settings, generation-bound
launch arguments and an unverified native effect. Inspect the native session
after an authorized launch before claiming its actual permission behavior.

The rig-level verbs are `rig policy permissions list`, `show`, `current` and
`apply`. Existing `rig policy list/show/current/apply` remain compatibility
aliases with the same JSON and exit behavior. Pi resource trust and the per-seat
typing guard are separate controls.

### Claude Code: a different launch flag

The shipped `first-project` uses Codex. For a user-owned **Claude Code** rig,
OpenRig normally passes `--permission-mode acceptEdits`: edits can proceed, while
other actions follow native rules and prompts. It does not add a global
`Bash(rig:*)` allowance. To explicitly select the bypass launch flag for that rig:

```sh
rig policy apply yolo --spec ./my-claude-rig/rig.yaml
rig policy current --spec ./my-claude-rig/rig.yaml
```

This records `permission_policy: builtin:yolo`; the next managed launch passes
`--dangerously-skip-permissions`. Member-level policies take precedence. To return
future launches to OpenRig's `acceptEdits` mode, use `rig policy apply none --spec
./my-claude-rig/rig.yaml` and remove any member-level bypass override. Native rules
and managed restrictions still matter; this flag is not a promise about sandbox
or account access. See [Claude permissions](https://code.claude.com/docs/en/permissions).

**Already running:** changing a file or running `rig policy apply` does not revoke
a live agent's permissions, nor rewrite a stored rig's policy on restore. Pause
work and use the native permission controls for that conversation (current
Codex and Claude CLIs expose `/permissions`); inspect the effective mode again.
Keep the launch spec/profile consistent for subsequent launches. If the native
version cannot apply the change in place, preserve the work and use the supported
same-seat stop/resume path after checking its retained policy; do not erase the
rig or start a duplicate to reset permissions. A resume can reapply the stored
launch mode, so verify the native mode again before continuing work.

## Custom settings and precedence

- **OpenRig:** member `permission_policy` overrides rig `permission_policy`.
  Normal managed launches bind the default mode explicitly when neither is set;
  exporting `OPENRIG_YOLO=1` in a client shell is not a reliable per-team recipe.
  A custom policy file is relative to the declaring rig spec, with no absolute
  path or `..`. `surface: flag` selects a launch mode. Config-surface policies
  (`locked`, `standard`, `open`, or custom) describe intent: recording one does
  not translate and enforce its rules. Apply and inspect the actual native
  settings separately. See [RigSpec policy references](rig-spec.md#attaching-a-permission-policy).
- **Codex:** personal settings live in `~/.codex/config.toml` or `CODEX_HOME`;
  trusted project settings live in `.codex/config.toml`. Current precedence is
  CLI overrides, trusted project settings, selected profile, user settings,
  cloud defaults when supplied, `/etc/codex/config.toml` on Unix, then built-in
  defaults, subject to managed requirements. OpenRig's explicit sandbox flag
  wins over a file's `sandbox_mode`; use `codex_config_profile` for a custom
  sandbox instead. For workspace edits with network access while retaining
  approvals, use a named profile with `sandbox_mode = "workspace-write"`,
  `approval_policy = "on-request"` and `[sandbox_workspace_write]`
  `network_access = true`. That grants network access generally, not just to
  the local daemon. See [Codex configuration](https://learn.chatgpt.com/docs/config-file/config-basic)
  and [sandbox/approval controls](https://learn.chatgpt.com/docs/agent-approvals-security).
- **Claude Code:** use `~/.claude/settings.json`, shared project
  `.claude/settings.json`, or personal project `.claude/settings.local.json`.
  Managed settings precede launch flags, then project-local, project-shared and
  user settings. Permission-rule lists combine; a higher-level allow is not a
  way to defeat a deny. OpenRig's `acceptEdits` launch flag overrides a file's
  `permissions.defaultMode`; selected runtime resources may also merge into
  project-local settings. See [Claude settings and precedence](https://code.claude.com/docs/en/settings)
  and [OpenRig's runtime config disclosure](agent-startup-guide.md#runtime-config-disclosure).

These recipes do not establish every provider/version/config combination.
Check the installed version and effective settings. Newer permission-profile or
automatic review features are provider choices, not implicit OpenRig capabilities.
Selecting rules or a broader mode does not change the shipped defaults.
