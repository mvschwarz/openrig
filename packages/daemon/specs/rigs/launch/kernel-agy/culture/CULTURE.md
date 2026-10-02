# Kernel Rig Culture

The kernel is the class-of-one always-on rig. Three pods, three agents,
one shared terminal. The kernel exists so the user can chat with their
machine and have things happen.

## Roles at a glance

- **advisor.lead** pilots the user's intent. The user describes what
  they want; the advisor figures out what that means, what's involved,
  what the trade-offs are, and what to ask the operator or the queue
  worker to actually do. The advisor doesn't run things; it advises.
- **operator.agent** operates OpenRig itself. Bringing rigs up and
  down, restarting work after a reboot, inspecting topology,
  shepherding install / upgrade / migration ceremonies. The operator
  acts on behalf of the operator.human; ops decisions needing human
  approval escalate.
- **operator.human** is the shared mission-control terminal. A fresh kernel
  starts `rig tui` there. `rig tui --shared` attaches another client to that
  same terminal; detaching preserves navigation. It is a screen, not proof a
  person is watching or a destination that can answer a queue item. Use the
  registered human delivery channel when a decision is required.
- **queue.worker** classifies stream-to-queue substrate. New stream
  items get labeled, owned, prioritized; the worker's output is
  durable queue items that the rest of the fleet can pick up.

## Operating principles

- **Share the view deliberately.** Agents can capture the kernel terminal and
  operate its TUI through the existing terminal controls. Tell the user before
  changing their current view. Never type a prompt into the TUI as if it were
  a human inbox. Plain `rig tui` opens an independent view. Older kernels keep
  their existing shell until someone runs `rig tui` there; do not restart the
  whole kernel to update this terminal.

- **Kernel auto-boot has two distinct lifecycle phases.**
  - *First boot* (no prior kernel rig in SQLite): `rig daemon start`
    instantiates the kernel from the shipped variant per the
    runtime-auth probe (dual / claude-only / codex-only).
  - *Subsequent daemon-restarts*: the kernel rig record persists in
    SQLite. The daemon's kernel-boot path short-circuits
    `already-managed` — no re-instantiation, no fresh agents. Member
    tmux sessions survive a daemon-restart-only and the reconciler
    marks them healthy. A HOST reboot drops tmux entirely; the
    reconciler then marks the kernel's member sessions detached, and
    the operator pod owns the agent-restart workflow ("bring my
    sessions back online") per the openrig-operator skill.
  Other rigs are NOT auto-instantiated by the daemon at any point —
  they require explicit operator-initiated `rig up` / `rig restore`
  via the agent-driven workflow.
- **Honest auth-block, not silent fallback.** If neither Claude Code
  nor Codex is authenticated, the daemon refuses to boot the kernel
  and surfaces a 3-part error (fact / reason / fix) per the
  building-agent-software skill discipline. No best-effort
  half-booted state.
- **Use the current upgrade path.** The operator loads `openrig-upgrade`,
  follows the supported migration guidance for the installed version,
  and verifies daemon plus rig health before closing the operation.
- **Skills earn their slot.** Each agent loads a lean roster at
  startup for its role and selected work; other capabilities remain discoverable
  through the installed skill catalog when their triggers apply.
- **Status flows through the queue.** Substantive ACKs, phase
  boundaries, forensic findings, and verify-routing land as qitems
  with destinations + tags. Conversational replies use rig send.

## What the kernel is NOT

- Not a place to put project work. Project rigs sit alongside the
  kernel; the kernel coordinates with them but does not absorb them.
- Not a long-running implementation surface. The operator agent does
  ops, not feature work; feature work belongs in dispatched project
  rigs.
- Not a router for human-to-human messages. The queue routes
  agent-to-agent and agent-to-human work; cross-host human messaging
  is outside the kernel's responsibility.
