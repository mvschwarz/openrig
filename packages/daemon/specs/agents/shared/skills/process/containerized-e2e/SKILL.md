---
name: containerized-e2e
description: Run end-to-end dogfood tests inside Docker containers to simulate real user experiences. Use when you need to verify install paths, control plane functionality, UI rendering, or packaging correctness in a clean environment. Triggers include "containerized test", "Docker dogfood", "clean install test", "e2e in container", or testing that requires a fresh environment without dev-mode shortcuts.
allowed-tools: Bash(docker:*), Bash(agent-browser:*), Bash(npx agent-browser:*)
---

# Containerized E2E Testing

Run OpenRig (or any npm-installable CLI + web UI project) through end-to-end testing inside Docker containers, simulating real user install and usage scenarios.

## When to Use

- Verifying the npm install path works from a packed tarball
- Testing control plane functionality without live agent runtimes
- Checking UI rendering via agent-browser in a clean environment
- Regression testing after packaging changes
- Phase boundary acceptance gates

## When NOT to Use

- Testing live agent behavior (send/capture/broadcast, whoami from inside an agent, transcript capture) — these need real claude-code/codex runtimes on the host
- Quick feedback during active TDD cycles — too slow for the edit/test loop

## Prerequisites

- Docker installed and running
- The repo builds successfully (`npm run build` for all workspaces)
- `agent-browser` skill loaded (for UI verification commands)

## Testing Personas

### Fresh User

A brand new user who has never installed OpenRig. Exercises the first-run experience.

- Empty `~/.openrig/` directory
- No existing rigs, snapshots, or specs
- Tests: install, daemon start, preflight, doctor, first rig up, UI renders

### Mature User

A user with existing OpenRig state — rigs, snapshots, library additions, transcripts.

- Pre-populated `~/.openrig/` via Docker volume persistence
- Build this state organically: run the fresh-user tests first, and the volume accumulates real state
- Tests: restore from existing snapshots, expand existing rigs, library with user-added specs, upgrade-path behaviors

To set up a mature user volume:

```bash
# Create a named volume
docker volume create openrig-mature-user

# Run fresh-user tests with the volume mounted
docker run -it --rm --shm-size=1g \
  -v openrig-mature-user:/root/.openrig \
  -v /tmp/openrig-e2e-artifacts:/artifacts \
  openrig-e2e

# The volume now has real state from actual rig commands
# Subsequent runs with the same volume simulate a mature user
```

## Workflow

### 1. Build the E2E Image

Use the provided build script or do it manually:

```bash
# Using the build script (recommended)
bash {SKILL_DIR}/scripts/build-e2e-image.sh /path/to/repo

# Or manually:
cd /path/to/repo
npm run build --workspace @openrig/daemon
npm run build --workspace @openrig/ui
npm run build --workspace @openrig/cli
bash scripts/build-package.sh
cd packages/cli && npm pack --pack-destination /tmp/e2e-build
cp {SKILL_DIR}/scripts/Dockerfile /tmp/e2e-build/
mv /tmp/e2e-build/openrig-cli-*.tgz /tmp/e2e-build/openrig-cli.tgz
cd /tmp/e2e-build && docker build -t openrig-e2e:latest .
```

### 2. Start the Container

```bash
# Fresh user (ephemeral state)
docker run -d --rm --name openrig-e2e \
  --shm-size=1g \
  -v /tmp/openrig-e2e-artifacts:/artifacts \
  openrig-e2e sleep infinity

# Mature user (persistent volume)
docker run -d --rm --name openrig-e2e \
  --shm-size=1g \
  -v openrig-mature-user:/root/.openrig \
  -v /tmp/openrig-e2e-artifacts:/artifacts \
  openrig-e2e sleep infinity
```

**Important:** Always use `--shm-size=1g` for Chromium stability during browser tests.

### 3. Run Tests Inside the Container

Execute commands via `docker exec`:

```bash
# Start the daemon
docker exec openrig-e2e rig daemon start

# Run preflight and doctor
docker exec openrig-e2e rig preflight --json
docker exec openrig-e2e rig doctor --json

# Copy test specs into the container
docker cp {SKILL_DIR}/templates/control-plane-test.yaml openrig-e2e:/workspace/
docker cp {SKILL_DIR}/templates/expansion-pod-fragment.yaml openrig-e2e:/workspace/
docker cp {SKILL_DIR}/templates/expansion-collision-fragment.yaml openrig-e2e:/workspace/

# Launch a rig
docker exec openrig-e2e rig up /workspace/control-plane-test.yaml --json

# Check topology
docker exec openrig-e2e rig ps --json
docker exec openrig-e2e rig ps --nodes --json
```

### 4. Browser Testing Inside the Container

agent-browser runs inside the container via `docker exec`:

```bash
# Open the daemon UI
docker exec openrig-e2e agent-browser open http://127.0.0.1:7433
docker exec openrig-e2e agent-browser wait --load networkidle

# Inspect interactive elements
docker exec openrig-e2e agent-browser snapshot -i

# Capture screenshots
docker exec openrig-e2e agent-browser screenshot /artifacts/screenshots/dashboard.png
docker exec openrig-e2e agent-browser screenshot --annotate /artifacts/screenshots/dashboard-annotated.png

# Navigate and verify specific surfaces
docker exec openrig-e2e agent-browser click @e4  # Open specs drawer (ref from snapshot)
docker exec openrig-e2e agent-browser wait 1000
docker exec openrig-e2e agent-browser screenshot /artifacts/screenshots/specs-drawer.png
```

**ARM64 note:** The Dockerfile uses Debian's system chromium instead of Chrome for Testing, which is unavailable on Linux ARM64. The environment variables `AGENT_BROWSER_EXECUTABLE_PATH` and `AGENT_BROWSER_ARGS` are set in the image.

### 5. Test Scenarios

#### Control Plane Lifecycle

```bash
# Launch the multi-pod test spec
docker exec openrig-e2e rig up /workspace/control-plane-test.yaml --json
RIG_ID=$(docker exec openrig-e2e rig ps --json | jq -r '.[0].rigId')

# Verify topology
docker exec openrig-e2e rig ps --nodes --json

# Expand with a new pod
docker exec openrig-e2e rig expand "$RIG_ID" /workspace/expansion-pod-fragment.yaml --json

# Verify expansion
docker exec openrig-e2e rig ps --nodes --json

# Test validation rejection (colliding namespace)
docker exec openrig-e2e rig expand "$RIG_ID" /workspace/expansion-collision-fragment.yaml --json
# Should fail with namespace collision error, rig unchanged

# Snapshot
docker exec openrig-e2e rig down "$RIG_ID" --snapshot --json

# Restore and verify
SNAPSHOT_ID=$(docker exec openrig-e2e rig snapshot list "$RIG_ID" | awk 'NR==2 {print $1}')
docker exec openrig-e2e rig restore "$SNAPSHOT_ID" --rig "$RIG_ID"

# Export
docker exec openrig-e2e rig export "$RIG_ID" -o /artifacts/captures/exported-rig.yaml
```

#### UI Verification

```bash
# After launching a rig, verify the graph renders
docker exec openrig-e2e agent-browser open http://127.0.0.1:7433
docker exec openrig-e2e agent-browser wait --load networkidle
docker exec openrig-e2e agent-browser snapshot -i
docker exec openrig-e2e agent-browser screenshot --annotate /artifacts/screenshots/graph-with-rig.png

# Open drawers and verify content
docker exec openrig-e2e agent-browser snapshot -i  # Get fresh refs
# Click through specs drawer, discovery drawer, rig detail, etc.
# Take screenshots at each step
```

### 6. Cleanup

```bash
docker exec openrig-e2e rig daemon stop
docker exec openrig-e2e agent-browser close
docker stop openrig-e2e
```

### 7. Write Report

Copy the report template and fill it in:

```bash
cp {SKILL_DIR}/templates/e2e-report-template.md /tmp/openrig-e2e-artifacts/report.md
```

Fill in results as tests complete — do not batch findings for the end.

## Test Spec Templates

| Template | Purpose |
|----------|---------|
| `templates/control-plane-test.yaml` | Multi-pod terminal-only rig spec (backend + frontend, 3 nodes, cross-pod edges) |
| `templates/expansion-pod-fragment.yaml` | Pod fragment for expansion happy path (ops pod with cross-pod edge) |
| `templates/expansion-collision-fragment.yaml` | Pod fragment that intentionally collides — for validation rejection testing |
| `templates/e2e-report-template.md` | Structured test report template |

## Scripts

| Script | Purpose |
|--------|---------|
| `scripts/build-e2e-image.sh` | Build the Docker image from the repo (builds packages, packs tarball, builds image) |
| `scripts/Dockerfile` | The proven Dockerfile — Node 22, tmux, system Chromium, agent-browser, OpenRig CLI |

## Limitations

- **No live agent runtimes.** The container does not include claude-code or codex. Use `runtime: terminal` specs for control plane testing. Test live agent behavior on the host.
- **ARM64 browser workaround.** Chrome for Testing is unavailable on Linux ARM64. The Dockerfile uses Debian chromium. This is transparent to agent-browser commands.
- **No GPU/display.** All browser testing is headless. Screenshots and videos capture what a user would see, but there is no visible browser window.

## Combining with Host-Based Dogfood

For complete coverage, use both approaches:

| What to test | Where | Tool |
|-------------|-------|------|
| Install path, packaging | Container | This skill |
| CLI commands, lifecycle | Container | This skill |
| UI rendering, drawers | Container | This skill + agent-browser |
| Validation/error paths | Container | This skill |
| Live agent startup | Host | QA with /dogfood skill |
| Communication (send/capture) | Host | QA with live agents |
| Whoami from inside agent | Host | QA with live agents |
| Transcript capture | Host | QA with live agents |
| Chatroom with real participants | Host | QA with live agents |
