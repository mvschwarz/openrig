#!/bin/bash
set -euo pipefail

echo "=== Rigged North Star Demo ==="
echo ""

# Start daemon
echo "Starting daemon..."
if rig daemon start; then
  sleep 2
else
  echo "Daemon start returned non-zero; checking for an existing healthy daemon..."
  if rig ps --json >/dev/null 2>&1; then
    echo "Reusing existing healthy daemon."
  else
    echo "ERROR: daemon failed to start and no healthy daemon is available." >&2
    exit 1
  fi
fi

# Boot the demo topology
echo ""
echo "Booting demo topology..."
UP_OUTPUT=$(rig up demo/rig.yaml)
printf '%s\n' "$UP_OUTPUT"
RIG_ID=$(printf '%s\n' "$UP_OUTPUT" | sed -n 's/^Rig: //p' | tail -n1)
if [ -z "$RIG_ID" ]; then
  echo "ERROR: failed to determine rig ID from 'rig up' output." >&2
  exit 1
fi

# Show node status
echo ""
echo "Node status:"
rig ps --nodes

# Establish a restore-safe baseline for the demo rig.
echo ""
echo "Checking native resume baseline..."
if npx tsx demo/scripts/verify-native-resume.ts --rig "$RIG_ID"; then
  echo "Native resume baseline already ready."
else
  echo ""
  echo "Fresh Claude sessions are not restore-safe yet. Seeding one warmup turn per agent..."
  npx tsx demo/scripts/seed-resume-baseline.ts --rig "$RIG_ID" --max-rounds 1
fi

echo ""
echo "Final baseline status:"
npx tsx demo/scripts/check-demo-health.ts --rig "$RIG_ID"
npx tsx demo/scripts/verify-native-resume.ts --rig "$RIG_ID"

echo ""
echo "=== Demo topology is running ==="
echo "Dashboard: http://localhost:5173"
echo ""
echo "Next steps:"
echo "  rig ps --nodes          # Check node status"
echo "  rig down $RIG_ID        # Tear down (auto-snapshots)"
echo "  rig restore <snapshotId> --rig $RIG_ID   # Restore the exact snapshot you just created"
