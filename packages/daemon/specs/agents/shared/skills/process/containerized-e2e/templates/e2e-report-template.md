# Containerized E2E Test Report

Date: {{DATE}}
Persona: {{PERSONA}}
Image: openrig-e2e:latest

## Summary

- Tests run: {{TOTAL}}
- Passed: {{PASSED}}
- Failed: {{FAILED}}
- Skipped: {{SKIPPED}}

## Environment

- Node: {{NODE_VERSION}}
- tmux: {{TMUX_VERSION}}
- Chromium: {{CHROMIUM_VERSION}}
- OpenRig CLI: {{RIG_VERSION}}
- Platform: {{PLATFORM}}

## Test Results

### Install & Boot

| Test | Result | Notes |
|------|--------|-------|
| npm install -g | | |
| rig daemon start | | |
| rig preflight | | |
| rig doctor | | |
| UI loads in browser | | |

### Rig Lifecycle

| Test | Result | Notes |
|------|--------|-------|
| rig up (terminal-only spec) | | |
| rig ps / rig ps --nodes | | |
| Graph renders in browser | | |
| rig down --snapshot | | |
| rig restore | | |
| Restored nodes match | | |

### Expansion

| Test | Result | Notes |
|------|--------|-------|
| rig expand (happy path) | | |
| Graph updates after expand | | |
| ps --nodes shows new nodes | | |
| Expand with collision (rejected) | | |
| Rig unchanged after rejection | | |

### Snapshot/Restore with Expansion

| Test | Result | Notes |
|------|--------|-------|
| Snapshot captures expanded pods | | |
| Restore brings back expanded pods | | |
| Cross-pod edges survive restore | | |
| Export includes expanded topology | | |

### CLI Surface

| Test | Result | Notes |
|------|--------|-------|
| rig specs ls | | |
| rig specs show | | |
| rig config | | |
| rig whoami (daemon down) | | |
| rig export | | |

### UI Surface (agent-browser)

| Test | Result | Notes |
|------|--------|-------|
| Dashboard renders | | |
| Explorer sidebar | | |
| Specs drawer opens | | |
| Discovery drawer opens | | |
| System drawer opens | | |
| Rig detail drawer | | |
| Node detail in graph | | |

## Bugs Found

(Append each bug as discovered — do not batch)

## Artifacts

- Screenshots: /artifacts/screenshots/
- Videos: /artifacts/videos/
- CLI transcript: /artifacts/cli-transcript.txt
