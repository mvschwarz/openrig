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
#   4. To reset: kill both daemons + rm both OPENRIG_HOME dirs + re-run.
#
# Pre-conditions (operator install before running this):
#   - `rig` CLI on PATH
#   - Tailscale daemon active OR explicit LAN bind via OPENRIG_HOST (see
#     auth-bearer-tailscale-trust slice for the bind rules)
#
# Idempotency: the script refuses to clobber existing daemons; operator
# must clean state dirs to fully reset.

set -euo pipefail

BLANK_HOME="${BLANK_HOME:-$HOME/.openrig-blank}"
POPULATED_HOME="${POPULATED_HOME:-$HOME/.openrig-populated}"
BLANK_PORT="${BLANK_PORT:-7433}"
POPULATED_PORT="${POPULATED_PORT:-7434}"
FIXTURE_DIR="${FIXTURE_DIR:-$(dirname "$0")/../../packages/daemon/assets/vm-preview-fixtures}"

echo "==> VM preview two-daemon bootstrap"
echo "    BLANK_HOME=$BLANK_HOME (port $BLANK_PORT)"
echo "    POPULATED_HOME=$POPULATED_HOME (port $POPULATED_PORT)"
echo "    FIXTURE_DIR=$FIXTURE_DIR"

# Refuse to overwrite existing daemons — operator action required to reset.
if [ -f "$BLANK_HOME/daemon.json" ]; then
  echo "ERROR: blank daemon already running per $BLANK_HOME/daemon.json"
  echo "       Run: rig daemon stop --openrig-home $BLANK_HOME"
  echo "       Then: rm -rf $BLANK_HOME && rerun this script."
  exit 1
fi
if [ -f "$POPULATED_HOME/daemon.json" ]; then
  echo "ERROR: populated daemon already running per $POPULATED_HOME/daemon.json"
  echo "       Run: rig daemon stop --openrig-home $POPULATED_HOME"
  echo "       Then: rm -rf $POPULATED_HOME && rerun this script."
  exit 1
fi

mkdir -p "$BLANK_HOME" "$POPULATED_HOME"

# Start the blank-slate daemon — pristine first-launch UX.
echo "==> Starting blank-slate daemon (port $BLANK_PORT)"
rig daemon start \
  --openrig-home "$BLANK_HOME" \
  --port "$BLANK_PORT" \
  --db "$BLANK_HOME/openrig.sqlite"

# Start the populated daemon — runs alongside the blank one with its own state.
echo "==> Starting populated daemon (port $POPULATED_PORT)"
rig daemon start \
  --openrig-home "$POPULATED_HOME" \
  --port "$POPULATED_PORT" \
  --db "$POPULATED_HOME/openrig.sqlite"

echo
echo "==> Both daemons up. Seed the populated daemon with sample data:"
echo "    OPENRIG_HOME=$POPULATED_HOME OPENRIG_PORT=$POPULATED_PORT \\"
echo "      rig up product-team   # instantiate a sample rig"
echo
echo "    Copy workflow fixtures to operator workspace specs dir:"
echo "    cp $FIXTURE_DIR/workflows/*.yaml \$OPENRIG_WORKSPACE_SPECS_ROOT/workflows/"
echo "      (slice 11 auto-discovers them on GET /api/specs/library)"
echo
echo "==> Operator UI access:"
echo "    Blank-slate:  http://127.0.0.1:$BLANK_PORT"
echo "    Populated:    http://127.0.0.1:$POPULATED_PORT"
echo
echo "==> See conventions/vm-preview/README.md for the full workflow + how to extend."
