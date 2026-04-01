#!/bin/bash
set -e

PROOF_DIR="demo/proof"
mkdir -p "$PROOF_DIR"

echo "=== Rigged North Star Proof Package ==="
echo "Producing proof artifacts in $PROOF_DIR/"
echo ""

# 1. Boot
echo "Step 1: Boot demo topology..."
rigged up demo/rig.yaml 2>&1 | tee "$PROOF_DIR/up-transcript.txt"
echo ""

# 2. Node status
echo "Step 2: Node status after boot..."
rigged ps --nodes 2>&1 | tee "$PROOF_DIR/ps-nodes.txt"
echo ""

# 3. Health check after boot
echo "Step 3: Health check after boot..."
npx tsx demo/scripts/check-demo-health.ts --rig demo-rig --json 2>&1 | tee "$PROOF_DIR/health-after-boot.json"
echo ""

# 4. Seed resume baseline
echo "Step 4: Seed resume baseline..."
npx tsx demo/scripts/seed-resume-baseline.ts --rig demo-rig --output "$PROOF_DIR/seed-resume-baseline.json" 2>&1 | tee "$PROOF_DIR/seed-resume-baseline.txt"
echo ""

# 5. Native resume verification before down
echo "Step 5: Native resume verification before down..."
npx tsx demo/scripts/verify-native-resume.ts --rig demo-rig --output "$PROOF_DIR/native-resume-before-down.json" 2>&1 | tee "$PROOF_DIR/native-resume-before-down.txt"
echo ""

# 6. Get rig ID for down/restore
RIG_ID=$(rigged ps --json | node -e "process.stdin.on('data',d=>{const r=JSON.parse(d);if(r[0])process.stdout.write(r[0].rigId)})")
if [ -z "$RIG_ID" ]; then
  echo "ERROR: No rig found after boot. Proof failed."
  exit 1
fi
echo "Rig ID: $RIG_ID"

# 7. Tear down
echo ""
echo "Step 6: Tear down..."
rigged down "$RIG_ID" 2>&1 | tee "$PROOF_DIR/down-transcript.txt"
echo ""

# 8. Verify no orphan tmux sessions
echo "Step 7: Orphan session check..."
tmux ls 2>&1 | tee "$PROOF_DIR/tmux-check.txt" || echo "No tmux server running (clean)" | tee "$PROOF_DIR/tmux-check.txt"
echo ""

# 9. Restore via name
echo "Step 8: Restore via rig name..."
rigged up demo-rig 2>&1 | tee "$PROOF_DIR/restore-transcript.txt"
echo ""

# 10. Node status after restore
echo "Step 9: Node status after restore..."
rigged ps --nodes 2>&1 | tee "$PROOF_DIR/ps-restored.txt"
echo ""

echo "=== Automated proof artifacts produced ==="
echo ""
echo "Manual steps remaining:"
echo "  1. Open http://localhost:5173 in browser"
echo "     Screenshot Explorer + Graph + Detail Panel"
echo "     Save to: $PROOF_DIR/browser-screenshot.png"
echo ""
echo "  2. Run: tmux attach -t orch-lead@demo-rig"
echo "     Ask: 'What were you working on?'"
echo "     Copy response to: $PROOF_DIR/resume-test.txt"
echo ""
echo "Proof artifacts:"
ls -la "$PROOF_DIR/"
