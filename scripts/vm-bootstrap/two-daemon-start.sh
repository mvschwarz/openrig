#!/usr/bin/env bash
# Slice 22 (release-0.3.1) — VM preview two-daemon bootstrap.
#
# Starts two OpenRig daemons in the same VM with fully isolated state
# (separate OPENRIG_HOME dirs, distinct ports, distinct SQLite paths)
# so a founder can compare a blank-slate "first install" UI to a
# pre-populated "lived-in" UI side-by-side.
#
# Operator workflow (per <substrate-shared-docs>/openrig-work/conventions/vm-preview/README.md):
#   1. Provision a Tart VM with OpenRig CLI installed.
#   2. Run this script.
#   3. Open two browser tabs:
#        http://<vm-ip>:7433  →  blank-slate (default, fresh install UX)
#        http://<vm-ip>:7434  →  populated  (sample rig + qitems for "lived-in" UX)
#   4. To reset, see "RESET" section at the bottom of this file.
#
# Pre-conditions (operator install before running this):
#   - `rig` CLI on PATH
#   - Tailscale daemon active OR explicit LAN bind via OPENRIG_HOST (see
#     auth-bearer-tailscale-trust slice for the bind rules)
#
# Architecture note (forward-fix #1): the CLI's parent-process module-
# level constants (OPENRIG_DIR / STATE_FILE / LOG_FILE in
# packages/cli/src/daemon-lifecycle.ts) resolve from OPENRIG_HOME at
# import time. So per-invocation `OPENRIG_HOME=<dir> rig daemon start`
# isolates BOTH the spawned daemon's state AND the CLI's lifecycle
# bookkeeping (daemon.json, daemon.log) in the same dir. The earlier
# attempt to add a `--openrig-home` flag was dropped because it only
# threaded into the spawned child, leaving the parent CLI's state
# writes on the default ~/.openrig path.
#
# Idempotency: each daemon's $OPENRIG_HOME has its own daemon.json, so
# re-running the script after a clean shutdown re-creates state. If a
# daemon is still running, `rig daemon start` (under the matching
# OPENRIG_HOME) refuses to launch a duplicate.

set -euo pipefail

BLANK_HOME="${BLANK_HOME:-$HOME/.openrig-blank}"
POPULATED_HOME="${POPULATED_HOME:-$HOME/.openrig-populated}"
BLANK_PORT="${BLANK_PORT:-7433}"
POPULATED_PORT="${POPULATED_PORT:-7434}"
FIXTURE_DIR="${FIXTURE_DIR:-$(dirname "$0")/../../packages/daemon/assets/vm-preview-fixtures}"

print_reset_instructions() {
  cat <<EOF
==> RESET (when you want a clean start):
    OPENRIG_HOME=$BLANK_HOME rig daemon stop
    OPENRIG_HOME=$POPULATED_HOME rig daemon stop
    rm -rf $BLANK_HOME $POPULATED_HOME
EOF
}

start_daemon_or_explain_reset() {
  local label="$1"
  local home="$2"
  local port="$3"

  echo "==> Starting $label daemon (port $port)"
  if ! OPENRIG_HOME="$home" rig daemon start \
    --port "$port" \
    --db "$home/openrig.sqlite"; then
    echo
    echo "ERROR: $label daemon did not start. If a preview daemon is already running, clean it up and rerun:" >&2
    print_reset_instructions >&2
    exit 1
  fi
}

echo "==> VM preview two-daemon bootstrap"
echo "    BLANK_HOME=$BLANK_HOME (port $BLANK_PORT)"
echo "    POPULATED_HOME=$POPULATED_HOME (port $POPULATED_PORT)"
echo "    FIXTURE_DIR=$FIXTURE_DIR"

mkdir -p "$BLANK_HOME" "$POPULATED_HOME"

# Start the blank-slate daemon — pristine first-launch UX. OPENRIG_HOME
# env (NOT a CLI flag) ensures both the spawned daemon AND the CLI's
# own state writes (daemon.json, daemon.log) land under $BLANK_HOME.
start_daemon_or_explain_reset "blank-slate" "$BLANK_HOME" "$BLANK_PORT"

# Start the populated daemon — runs alongside the blank one with its own
# OPENRIG_HOME so neither sees the other's state.
start_daemon_or_explain_reset "populated" "$POPULATED_HOME" "$POPULATED_PORT"

echo
echo "==> Both daemons up. Seed the populated daemon with sample data:"
echo "    OPENRIG_HOME=$POPULATED_HOME OPENRIG_PORT=$POPULATED_PORT \\"
echo "      rig up product-team   # instantiate a sample rig"
echo
echo "    Copy workflow fixtures to operator workspace specs dir:"
echo "    cp $FIXTURE_DIR/workflows/*.yaml \\"
echo "      \$OPENRIG_WORKSPACE_SPECS_ROOT/workflows/"
echo "      (slice 11 auto-discovers them on GET /api/specs/library)"
echo
echo "==> Operator UI access:"
echo "    Blank-slate:  http://127.0.0.1:$BLANK_PORT"
echo "    Populated:    http://127.0.0.1:$POPULATED_PORT"
echo
print_reset_instructions
echo
echo "==> See conventions/vm-preview/README.md for the full workflow + how to extend."
