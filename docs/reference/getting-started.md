# Getting started: the guided golden path

This is the ordered new-operator path from a fresh machine to a running rig with
a workspace and a workflow. It uses the **existing** `rig` verbs in order - there
is no magic one-command onboarding; each step is a real, inspectable verb.

> Everything below reports **what is currently true**, never a guarantee that
> downstream work will succeed. "Daemon up" does not mean every agent is healthy;
> "kernel ready" does not mean every kernel agent is healthy; a workspace root
> being *live* does not mean it is the *right* one for your project.

## The ordered path

1. **`rig setup`** - install and verify the local runtime (tmux, cmux, Claude
   Code / Codex, runtime config). Run once per machine. `rig setup` does NOT boot
   the kernel (see "Kernel framing" below).
2. **`rig up <rig-spec>`** - launch a rig. This **auto-starts the daemon** if it
   is not already running (the four daemon-dependent verbs below do not auto-start
   it - they tell you to run `rig up` or `rig daemon start`).
3. **`rig status`** - see what is currently true: daemon up/down + port, kernel
   readiness (distinct from daemon health), and your effective workspace root
   (default vs override).
4. **`rig workspace doctor`** - check that your workspace is ready; it reports
   state + fix-hints. The effective workspace root defaults to
   `~/.openrig/workspace/` unless you override `workspace.root` (env or config).
5. **`rig workflow instantiate <name>`** - start a workflow runtime instance by
   its **discovered name** (e.g. `conveyor`, `basic-loop`) - no hidden file path
   needed. `rig workflow list` shows the seeded built-ins. Instantiating creates a
   workflow instance and its first **entry qitem**.
6. **`rig scope ...`** - browse and manage the durable mission/slice artifacts the
   workflow coordinates (see the scope <-> workflow bridge below).

`rig setup` prints this ordered sequence as its next-steps output; `rig status`
points back here. This doc is the durable reference.

## Kernel framing (what `rig setup` does and does not do)

The kernel rig **auto-boots on daemon-start** - it is daemon-start behavior, NOT
a `rig setup` step and NOT something you boot by hand. So:

- `rig setup` installs/verifies the runtime; it does not start the daemon or the
  kernel.
- Starting the daemon (`rig daemon start`, or implicitly via `rig up`) is what
  boots the kernel rig in the background.
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

How they relate: a scope slice is the durable description of a unit of work; a
workflow instance + its qitems are the live machinery that moves that work
through owners (hot-potato handoffs). They are not auto-bridged - there is no
auto-instantiate-from-scope - you instantiate a workflow by name when you want to
run one, and you reference your scope artifacts as the work it coordinates. A
typical loop: author/track the unit in `rig scope`, then
`rig workflow instantiate <name>` to start the runtime that drives it.
