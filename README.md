# OpenRig

OpenRig is a local control plane for multi-agent coding topologies.

It gives you:
- a daemon and UI for running, inspecting, and steering rigs of coding agents
- a CLI designed for both humans and agents
- tmux-backed node management, transcripts, messaging, and recovery
- rig environments for service-backed apps
- agent-managed software, where an app ships with its own specialist agent

## Install

OpenRig requires:
- Node.js 20+
- `tmux`

Optional but recommended:
- `cmux` for `Open CMUX` / node surface controls
- Docker Desktop or Docker Engine for service-backed rigs and managed apps like `secrets-manager`

Install the CLI:

```bash
npm install -g @openrig/cli
```

## First Run

Start here:

```bash
rig doctor
```

`rig doctor` is the host-health and system-administration entry point for OpenRig.

It checks:
- packaged daemon and UI assets
- Node version
- `tmux`
- optional `cmux` control health
- writable OpenRig state paths
- daemon port availability

For agent-friendly output:

```bash
rig doctor --json
```

If `cmux` is missing or unavailable, `rig doctor` reports a `WARN`, not a hard failure. OpenRig still works without it; only `Open CMUX` workflows are unavailable.

## Start OpenRig

Start the daemon:

```bash
rig daemon start
```

Check status:

```bash
rig status
```

Open the UI:

```bash
rig ui open
```

## Quick Examples

Launch the shipped managed-app example:

```bash
rig up secrets-manager
```

Inspect service state:

```bash
rig env status secrets-manager
```

Talk to the Vault specialist:

```bash
rig send vault-specialist@secrets-manager "Check Vault health and report status." --verify
```

## System Administration

Use these commands as the default operational surface:

```bash
rig doctor
rig status
rig daemon status
rig daemon logs --follow
```

Use `rig doctor` for host and install health.

Use `rig requirements <spec>` for spec-specific requirements:

```bash
rig requirements path/to/rig.yaml
```

That separation matters:
- `rig doctor` answers: is this machine ready for OpenRig?
- `rig requirements` answers: is this machine ready for this specific rig or app?

## Open CMUX

If `cmux` is installed and controllable, OpenRig can open or focus a CMUX surface for any node from the graph or node detail view.

For tmux-backed nodes, OpenRig opens a CMUX terminal and attaches into the node’s tmux session automatically.

If `cmux` control is unavailable:
- OpenRig still runs normally
- `Open CMUX` actions will not work until `rig doctor` reports `cmux` healthy or warned-understood

## Notes

- `rig` is designed to support both humans and coding agents.
- Many commands support `--json`.
- Cross-rig messaging is supported when the target session resolves uniquely.
- Managed apps are launched through the normal rig/spec surfaces; the current canonical example is `secrets-manager`.
