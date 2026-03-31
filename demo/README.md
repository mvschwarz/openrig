# North Star Demo

A complete multi-agent topology demonstrating Rigged's core capabilities.

## Topology

- **orch** pod: `lead` (claude-code) — orchestrator
- **dev** pod: `impl` (claude-code), `qa` (codex), `design` (claude-code)
- **rev** pod: `r1` (claude-code), `r2` (codex)
- **infra** pod: `daemon` (terminal, monitoring), `ui` (terminal, cwd: packages/ui)
- Edges: `orch.lead` delegates to `dev.impl`, `dev.qa` observes `dev.impl`, `rev.r1` collaborates with `rev.r2`

8 nodes across 4 pods. 6 agent harnesses + 2 terminal infrastructure nodes.

## Prerequisites

- Node.js 22+
- tmux 3+
- Rigged built: `npm run build` from repo root
- Claude Code and/or Codex CLI installed

## Quick Start

```bash
./demo/run.sh
```

## Full Proof Package

```bash
./demo/run-proof.sh
```

This produces automated proof artifacts in `demo/proof/`:

| Artifact | Source | Type |
|----------|--------|------|
| `up-transcript.txt` | `rigged up demo/rig.yaml` output | Automatic |
| `ps-nodes.txt` | `rigged ps --nodes` after boot | Automatic |
| `down-transcript.txt` | `rigged down` output | Automatic |
| `tmux-check.txt` | `tmux ls` after teardown | Automatic |
| `restore-transcript.txt` | `rigged up demo-rig` output | Automatic |
| `ps-restored.txt` | `rigged ps --nodes` after restore | Automatic |
| `browser-screenshot.png` | Explorer + Graph + Detail Panel | **Manual** |
| `resume-test.txt` | Post-restore agent context check | **Manual** |

### Manual Steps

After `run-proof.sh` completes:

1. **Browser screenshot:** Open `http://localhost:5173` → screenshot showing Explorer with all pods, Graph with pod grouping, Node Detail Panel open. Save to `demo/proof/browser-screenshot.png`.

2. **Resume test:** Run `tmux attach -t orch-lead@demo-rig` → ask "What were you working on?" → copy response to `demo/proof/resume-test.txt`.

## Expected Session Names

After boot, `tmux list-sessions` should show:
```
orch-lead@demo-rig
dev-impl@demo-rig
dev-qa@demo-rig
dev-design@demo-rig
rev-r1@demo-rig
rev-r2@demo-rig
infra-daemon@demo-rig
infra-ui@demo-rig
```

## Expected Boot Time

6 harness launches + 2 terminal launches. Sequential (topological order). Expected total: 2-5 minutes depending on hardware.
