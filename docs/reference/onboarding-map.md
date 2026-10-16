# OpenRig Onboarding Map

> A goal-based index. It points you to *where a task lives* in the existing docs — it does
> not restate the steps. Follow a link, do the thing there, return here for the next goal.
>
> - **You're adopting OpenRig (you use it):** start with the [getting started](getting-started.md) journey.
> - **You're building or maintaining OpenRig (you change it):** the `as-built/` docs are canonical — see [For maintainers](#for-maintainers-building-and-operating-openrig) at the end.

## Before you start

- **Is OpenRig ready?** — the 3‑command pre‑flight check → [Before you start](getting-started.md#before-you-start)
- [Install and sign in](getting-started.md#install-and-sign-in)
- [Choose your providers](getting-started.md#choose-your-providers)
- [Start the kernel and read its state](getting-started.md#start-the-kernel-and-check-its-state)

## Shortest path to your first working team

Six links, no restated steps — the fast path as navigation:

1. [Install and sign in](getting-started.md#install-and-sign-in)
2. [Start the kernel and check its state](getting-started.md#start-the-kernel-and-check-its-state)
3. [Choose your first team](getting-started.md#choose-your-first-team)
4. [Launch the starter team](getting-started.md#launch-the-starter-team)
5. [Give the builder an outcome](getting-started.md#give-the-builder-an-outcome)
6. [Open the kernel conversations (watch)](getting-started.md#open-the-kernel-conversations)

---

## 1. Understand how OpenRig works

The mental model: rig / pod / seat / harness / daemon, and how they relate.

- [Naming rigs, pods and seats](topology-naming.md)
- [Agent state taxonomy](agent-state-taxonomy.md)
- [Edge types](edge-types.md)
- [RigSpec reference](rig-spec.md) · [AgentSpec reference](agent-spec.md)
- [Kernel framing — what a rig setup does and does not do](getting-started.md#kernel-framing-what-rig-setup-does-and-does-not-do)
- *Deeper / implementation* → [as-built/architecture/](../as-built/architecture/)

## 2. Configuration, storage & machine state

Where files live and what OpenRig changes on your machine.

- [Instance layout — `$OPENRIG_HOME`](instance-layout.md)
- [Context library / System World](instance-layout.md#context-library-setting)
- [Project workspace contract](project-workspace.md)
- [Agent startup: skills vs startup files](agent-startup-guide.md)
- [Non-interruptive mode](non-interruptive-mode.md)
- [Custom settings and precedence](getting-started.md#custom-settings-and-precedence)

## 3. Onboard your first project

Bring an existing codebase into OpenRig cleanly.

- [Project workspace contract](project-workspace.md#default-shape)
- [The mission install](mission-install.md)
- [Worktree builds](worktree-builds.md)
- [Continue real project work (journey)](getting-started.md#continue-real-project-work)

## 4. Choose & operate your first rig

Launch, watch, direct, and restore a team.

- [Choose your first team](getting-started.md#choose-your-first-team)
- [Launch the starter team](getting-started.md#launch-the-starter-team)
- [RigBundle reference](rig-bundle.md) · [Rosters — find specialists](rosters.md)
- [Open the kernel conversations (watch)](getting-started.md#open-the-kernel-conversations)
- [Talk to the operator in any terminal](getting-started.md#talk-to-the-operator-in-any-terminal)
- [Plain terminal: a new viewing session](getting-started.md#plain-terminal-a-new-viewing-session)
- [Existing provider workspaces](getting-started.md#existing-provider-workspaces)
- [Give the builder an outcome — `rig send`](getting-started.md#give-the-builder-an-outcome)
- [Stop, snapshot & restore](getting-started.md#stop-your-teams)

## 5. Daily workflows, SDLC & craft

How work moves: intent → plan → build → proof → review.

- [SDLC conventions](sdlc-conventions.md)
- [Product-journey SDLC components](product-journey-sdlc.md)
- [The wave SDLC](wave-sdlc.md)
- [Scoped operating posture](scoped-operating-posture.md)
- [The scope ↔ workflow bridge](getting-started.md#the-scope--workflow-bridge)
- [Knowledge maturity — the craft ladder](knowledge-maturity.md)
- [The Refocus Channel (compaction recovery)](refocus-channel.md)

## 6. Get unstuck

- [Help your user get unstuck](help.md)
- [What can interrupt installation and the OpenRig view](getting-started.md#what-can-interrupt-installation-and-the-openrig-view)
- [Continue after a native consent prompt](agent-startup-guide.md#continue-after-a-native-consent-prompt)
- [Incomplete setup and restart](getting-started.md#incomplete-setup-and-restart)
- [Agent-operated health diagnosis](health-diagnosis.md)
- [Permissions & prompts](non-interruptive-mode.md)
- [Opt-in permissive operation](getting-started.md#opt-in-permissive-operation)
- [Installing-agent handoff](getting-started.md#installing-agent-handoff) · [Headless or SSH handoff](getting-started.md#headless-or-ssh-handoff)
- [WSL2 / port 7433](getting-started.md#wsl2-a-reported-working-setup)

---

## For maintainers — building & operating OpenRig

Canonical implementation docs (not the adopting-user journey).

- [As-built architecture (index)](../as-built/README.md)
- [CLI reference](../as-built/cli-reference.md)
- [Developing OpenRig](developing.md)
