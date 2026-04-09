#!/bin/bash
set -euo pipefail

PROOF_DIR="demo/proof"
mkdir -p "$PROOF_DIR"

echo "=== Rigged North Star Proof Package ==="
echo "Producing proof artifacts in $PROOF_DIR/"
echo ""

# 0. Start or reuse daemon
echo "Step 0: Ensure daemon is running..."
if rigged daemon start; then
  sleep 2
else
  echo "Daemon start returned non-zero; checking for an existing healthy daemon..."
  if rigged ps --json >/dev/null 2>&1; then
    echo "Reusing existing healthy daemon."
  else
    echo "ERROR: daemon failed to start and no healthy daemon is available." >&2
    exit 1
  fi
fi
echo ""

# 1. Boot
echo "Step 1: Boot demo topology..."
UP_OUTPUT=$(rigged up demo/rig.yaml 2>&1 | tee "$PROOF_DIR/up-transcript.txt")
RIG_ID=$(printf '%s\n' "$UP_OUTPUT" | sed -n 's/^Rig: //p' | tail -n1)
if [ -z "$RIG_ID" ]; then
  echo "ERROR: No rig ID found in boot output. Proof failed."
  exit 1
fi
echo ""

# 2. Node status
echo "Step 2: Node status after boot..."
rigged ps --nodes 2>&1 | tee "$PROOF_DIR/ps-nodes.txt"
echo ""

# 3. Health check after boot
echo "Step 3: Health check after boot..."
npx tsx demo/scripts/check-demo-health.ts --rig "$RIG_ID" --json 2>&1 | tee "$PROOF_DIR/health-after-boot.json"
echo ""

# 4. Native resume verification immediately after boot
echo "Step 4: Native resume verification immediately after boot..."
if npx tsx demo/scripts/verify-native-resume.ts --rig "$RIG_ID" --output "$PROOF_DIR/native-resume-after-boot.json" 2>&1 | tee "$PROOF_DIR/native-resume-after-boot.txt"; then
  echo "Native resume baseline was already ready after boot."
  cat > "$PROOF_DIR/seed-resume-baseline.txt" <<'EOF'
Baseline seeding skipped: native resume baseline was already ready after boot.
EOF
  cat > "$PROOF_DIR/seed-resume-baseline.json" <<'EOF'
{
  "skipped": true,
  "reason": "native resume baseline was already ready after boot"
}
EOF
else
  echo ""
  echo "Step 5: Seed resume baseline..."
  npx tsx demo/scripts/seed-resume-baseline.ts --rig "$RIG_ID" --max-rounds 1 --output "$PROOF_DIR/seed-resume-baseline.json" 2>&1 | tee "$PROOF_DIR/seed-resume-baseline.txt"
fi
echo ""

# 5. Native resume verification before down
echo "Step 6: Native resume verification before down..."
npx tsx demo/scripts/verify-native-resume.ts --rig "$RIG_ID" --output "$PROOF_DIR/native-resume-before-down.json" 2>&1 | tee "$PROOF_DIR/native-resume-before-down.txt"
echo ""

# 6. Use captured rig ID for down/restore
echo "Rig ID: $RIG_ID"

# 7. Tear down
echo ""
echo "Step 7: Tear down..."
DOWN_OUTPUT=$(rigged down "$RIG_ID" 2>&1 | tee "$PROOF_DIR/down-transcript.txt")
SNAPSHOT_ID=$(printf '%s\n' "$DOWN_OUTPUT" | sed -n 's/^Snapshot: //p' | tail -n1)
if [ -z "$SNAPSHOT_ID" ]; then
  echo "ERROR: No snapshot ID found in teardown output. Proof failed."
  exit 1
fi
echo "Snapshot ID: $SNAPSHOT_ID"
echo ""

# 8. Verify no orphan tmux sessions
echo "Step 8: Orphan session check..."
tmux ls 2>&1 | tee "$PROOF_DIR/tmux-check.txt" || echo "No tmux server running (clean)" | tee "$PROOF_DIR/tmux-check.txt"
echo ""

# 9. Restore via explicit snapshot + rig ID
echo "Step 9: Restore via explicit snapshot + rig ID..."
rigged restore "$SNAPSHOT_ID" --rig "$RIG_ID" 2>&1 | tee "$PROOF_DIR/restore-transcript.txt"
echo ""

# 10. Node status after restore
echo "Step 10: Node status after restore..."
rigged ps --nodes 2>&1 | tee "$PROOF_DIR/ps-restored.txt"
echo ""

echo "=== Automated proof artifacts produced ==="
echo ""
echo "Manual steps remaining:"
echo "  1. Open http://localhost:5173 in browser"
echo "     Screenshot Explorer + Graph + Detail Panel"
echo "     Save to: $PROOF_DIR/browser-screenshot.png"
echo ""
echo "  2. Run: tmux attach -t orch.lead@demo-rig"
echo "     Ask: 'What were you working on?'"
echo "     Copy response to: $PROOF_DIR/resume-test.txt"
echo ""
echo "Proof artifacts:"
ls -la "$PROOF_DIR/"
