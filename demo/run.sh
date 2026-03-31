#!/bin/bash
set -e

echo "=== Rigged North Star Demo ==="
echo ""

# Start daemon
echo "Starting daemon..."
rigged daemon start
sleep 2

# Boot the demo topology
echo ""
echo "Booting demo topology..."
rigged up demo/rig.yaml

# Show node status
echo ""
echo "Node status:"
rigged ps --nodes

echo ""
echo "=== Demo topology is running ==="
echo "Dashboard: http://localhost:5173"
echo ""
echo "Next steps:"
echo "  rigged ps --nodes          # Check node status"
echo "  rigged down <rigId>        # Tear down (auto-snapshots)"
echo "  rigged up demo-rig         # Restore from snapshot"
