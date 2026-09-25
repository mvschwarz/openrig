# Getting started: one useful change in your repository

Start with a repository and one bounded change you can exercise. The shipped
`first-project` starter provides two native Codex seats: an outcome owner and
an independent checker. It uses your installed Codex executable and login;
terminal-provider support does not change the harness or account being used.

**Choose permissions before starting the team.** The unchanged starter launches
Codex with `-s workspace-write`; it leaves approval policy to your native Codex
configuration. Network access is normally off in that sandbox, including access
to the local OpenRig daemon. Its `profile: default` selects OpenRig resources,
not a Codex permission profile. Ordinary permission prompts are therefore expected.
You can keep those prompts, [choose an explicit permissive setup](#opt-in-permissive-operation),
or [configure a custom policy](#custom-settings-and-precedence). OpenRig does not
choose permissive operation for everyone.

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

Install OpenRig and inspect `rig setup --dry-run` before applying machine
changes. Check `tmux -V`, `codex --version` and `codex login status` in your
launch shell; install missing prerequisites and complete `codex login` when
needed. This starter needs tmux and Codex, without a Claude login or Herdr
plugin. The kernel selects its available native runtime variant separately.

`rig setup` currently installs/checks both harnesses and cmux. Use it when you
want that full environment. Its overall failure can include an optional
component for this starter: read the individual result and verify the three
prerequisites above rather than treating a missing Claude login as broken
Codex. A missing Codex login remains a real launch blocker.

```sh
cd <your-repository>
rig specs preview first-project
rig up first-project --cwd . --plan
rig up first-project --cwd .
rig status
rig ps --nodes --rig first-project
```

Preview the starter's seats and resources; plan checks resolution and
preflight for the selected working directory. Launch starts the daemon if needed; the kernel boots in the
background. Read readiness for the project seats, not only daemon health. If a
seat has an authentication, trust or permission prompt, resolve the named
prompt before assigning it work. A model pin is configuration; the native
harness must report the intended model before consequential work.

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

`first-project` is a deliberately small starting point, not a universal team.
For a different installed runtime or team shape, inspect `rig specs ls --kind
rig` and `rig specs preview <name>` before selecting it. A seven-seat showcase
is optional and consumes more concurrent capacity.

## Give the owner an outcome

For example, in a project that imports CSV files:

```sh
rig send dev-owner@first-project 'Improve the CSV import error when a required column is missing: name the column and leave the existing data unchanged. Add a regression check, ask dev-check for an independent check of the exact candidate, and record the result and how I can try it. Keep the change local; do not publish.'
```

Replace the example with a real problem in your repository. Include what the
user should observe, a boundary and how success can be checked. The owner
creates and claims a durable task, implements it, and routes the selected
independent check. You should not have to relay the review between terminals.
`rig send` is the initial conversation; the queue and repository artifacts
retain the work. An unbound shell does not need to impersonate a queue owner.

From an actual `first-project` seat, follow the work with
`rig queue list --limit 1000`: its default scope is the caller's current rig.
`queue list` has no `--rig` option. From an observer shell or another rig, use
`rig queue list --destination dev-owner@first-project --limit 1000` and the same
command for `dev-check@first-project`, after verifying those live addresses.
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
Herdr, use `rig terminal open first-project --provider herdr`; for the shared
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
with a complete `rig expand` fragment, or optionally author a custom rig. It covers
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

OpenRig's separate `permission_policy: builtin:yolo` setting passes only
`-s danger-full-access` to Codex, **without an approval flag**, and replaces the
named-profile argument. It does not mean `approval_policy = "never"`. A standalone
`codex --yolo` command is not an OpenRig launch setting. Use the profile recipe
above when you want to choose both controls explicitly.

To return to a restricted next launch, change the selected profile to:

```toml
sandbox_mode = "workspace-write"
approval_policy = "on-request"

[sandbox_workspace_write]
network_access = false
```

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

These are source-checked recipes for this OpenRig release, not a native test of
every provider/version/config combination. Codex 0.155.1 was observed requesting
approval for local `rig` calls under workspace-write with network disabled;
that does not establish every timeout's cause. Provider docs evolve: check your
installed version and effective settings. Newer permission-profile or automatic
review features are provider choices, not implicit OpenRig capabilities. Private
startup fixes do not change the released permission defaults described here.
